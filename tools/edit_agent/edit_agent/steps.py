"""The steps of a first pass. Each one reads and writes files in the run folder and returns small dicts.

Pixels never leave this PC: the VLM is the local llama.cpp server, SAM and the image model are local
programs. The graph nodes in graph.py decide who holds the GPU; nothing here loads a model by itself.
"""
import json
import re
import subprocess
import time
from pathlib import Path

import numpy as np
from langchain_core.messages import HumanMessage
from PIL import Image, ImageDraw, ImageFilter

from edit_agent import metrics, scout
from edit_agent.config import QWEN
from edit_agent.models import chat_model
from edit_agent.schemas import (COMPARE_PROMPT, COMPARE_SCHEMA, LOCATE_PROMPT, LOCATE_SCHEMA, PLACE_PROMPT,
                                PLACE_SCHEMA, SURFACE_PROMPT, SURFACE_SCHEMA, VISIBLE_PROMPT, Target, edit_prompt,
                                visible_schema)
from run_qwen import MODELS, QUANTS, SD_CLI, VAE, VISION, VramMonitor, grow_mask, membrane
from vlm import data_url

SAM_PYTHON = QWEN / ".venv-sam" / "Scripts" / "python.exe"


def prepare(image, scan, preset, run):
    """Write the working image: the given picture, or a view rendered from a downloaded scan."""
    if image:
        img = Image.open(image).convert("RGB")
    elif scan:
        from pano import Camera, Scan
        s = Scan(scan["model"])
        camera = Camera.from_angles(s.position(scan["pano"]), scan.get("yaw", 0), scan.get("pitch", 0),
                                    scan.get("fov", 75), preset.work_px, preset.work_px)
        img = s.view(scan["pano"], camera)
    else:
        raise ValueError("give an `image` path or a `scan` view")
    scale = min(1.0, preset.work_px / max(img.size))
    size = tuple(max(16, round(side * scale / 16) * 16) for side in img.size)   # the tone match needs multiples of 16
    if size != img.size:
        img = img.resize(size, Image.LANCZOS)
    out = run / "view.png"
    img.save(out)
    return out, size


def look(server, preset, images, text, schema, max_tokens=900):
    """One question about some images, answered as JSON of the given shape.

    The images travel in a user message. Tool results stay text, because chat-completion servers
    only promise to read images from user messages.
    """
    if preset.eyes.provider != "local":
        raise ValueError("images go only to local models: the `eyes` role must use the local provider")
    model = chat_model(preset.eyes, base_url=server.url, max_tokens=max_tokens)
    content = [{"type": "image_url", "image_url": {"url": data_url(p, preset.vlm_px)}} for p in images]
    content.append({"type": "text", "text": text})
    t0 = time.time()
    out = model.with_structured_output(schema, method="json_schema", include_raw=True).invoke([HumanMessage(content)])
    if out.get("parsing_error") or out.get("parsed") is None:
        raise RuntimeError(f"the VLM's JSON was cut off or malformed: {out['raw'].content!r}")
    usage = out["raw"].usage_metadata or {}
    return out["parsed"], {"answer_s": round(time.time() - t0, 1), "input_tokens": usage.get("input_tokens"),
                           "output_tokens": usage.get("output_tokens")}


def to_pixels(box, size):
    """Qwen3-VL writes boxes on a 0-1000 scale whatever the image size."""
    w, h = size
    x0, y0, x1, y1 = (round(min(max(v, 0), 1000) / 1000 * side) for v, side in zip(box, (w, h, w, h)))
    return [min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)]


def _target(target, view):
    """The form every later step reads: boxes in pixels of the view, and the image model's prompt."""
    size = Image.open(view).size
    boxes = [{"label": b.label, "bbox_2d": b.bbox_2d, "box": to_pixels(b.bbox_2d, size)} for b in target.boxes]
    boxes = [b for b in boxes if b["box"][2] - b["box"][0] > 2 and b["box"][3] - b["box"][1] > 2]
    if not target.found:
        boxes = []
    return {**target.model_dump(exclude={"boxes"}), "boxes": boxes, "prompt": edit_prompt(target)}


def locate(server, view, request, preset):
    answer, info = look(server, preset, [view], LOCATE_PROMPT.format(text=request), LOCATE_SCHEMA)
    return _target(Target.model_validate(answer), view), info


def adopt(target, view):
    """Take a target that was found elsewhere (a click, a search of the scan) instead of asking the VLM.

    It needs item, kind, behind, instruction and boxes [{label, bbox_2d}] on the 0-1000 scale of the picture.
    """
    return _target(Target.model_validate({"found": True, **target}), view)


def adopt_mask(mask, view, preset, run):
    """Take a mask that was made elsewhere (white = the item). It is resized to the view."""
    size = Image.open(view).size
    item = Image.open(mask).convert("L").resize(size, Image.NEAREST).point(lambda v: 255 if v > 127 else 0)
    if not item.getbbox():
        raise ValueError(f"the given mask is empty: {mask}")
    out = run / "mask.png"
    grow_mask(item, round(preset.mask_grow * max(size))).save(out)
    return out


def segment(view, boxes, preset, run):
    """SAM 2.1 cuts out the object in each box. Returns the mask path, or None if SAM found nothing."""
    jobs_path = run / "sam_jobs.json"
    jobs = [{"image": str(view), "out": str(run / f"sam_{i}.png"), "box": b["box"]} for i, b in enumerate(boxes)]
    jobs_path.write_text(json.dumps(jobs, indent=2), encoding="utf-8")
    proc = subprocess.run([str(SAM_PYTHON), "-I", str(QWEN / "segment.py"), "prompt", "--jobs", str(jobs_path)],
                          capture_output=True, text=True, errors="replace")
    if proc.returncode:
        raise RuntimeError(f"segment.py failed:\n{proc.stdout[-2000:]}\n{proc.stderr[-3000:]}")
    jobs = json.loads(jobs_path.read_text(encoding="utf-8"))
    union = None
    for job in jobs:
        m = np.asarray(Image.open(job["out"]).convert("L")) > 127
        union = m if union is None else union | m
    if union is None or not union.any():
        return None, {"mask_share": 0.0}
    mask = Image.fromarray(union.astype(np.uint8) * 255)
    mask = grow_mask(mask, round(preset.mask_grow * max(mask.size)))      # cover the soft edge of the object
    out = run / "mask.png"
    mask.save(out)
    return out, {"mask_share": round(float(union.mean()), 4), "sam_scores": [j.get("score") for j in jobs]}


def generate(view, prompt, preset, run):
    """Qwen-Image-2.1 redraws the whole view from the instruction. One sd-cli call, which loads the model."""
    q = QUANTS[preset.quant]
    w, h = Image.open(view).size
    raw = run / "raw.png"
    cmd = [str(SD_CLI),
           "--diffusion-model", str(MODELS / q["diffusion"]), "--vae", str(MODELS / VAE),
           "--llm", str(MODELS / q["llm"]), "--llm_vision", str(MODELS / VISION),
           "-r", str(view), "-p", prompt,
           "--cfg-scale", str(preset.cfg), "--sampling-method", "euler", "--steps", str(preset.steps),
           "-W", str(w), "-H", str(h), "--seed", str(preset.seed),
           "--flash-attn", "off,diffusion=on", "-v", "-o", str(raw)]
    monitor = VramMonitor()
    monitor.start()
    proc = subprocess.run(cmd, capture_output=True, text=True, errors="replace")
    monitor.stop()
    log = f"PROMPT: {prompt}\n\n{proc.stdout}\n--- stderr ---\n{proc.stderr}"
    (run / "generate.log").write_text(log, encoding="utf-8")
    if not raw.exists():
        raise RuntimeError(f"sd-cli wrote no image (exit {proc.returncode}), see {run / 'generate.log'}")
    info = {"vram_peak_mb": monitor.peak, "size": [w, h], "steps": preset.steps}
    sampling = re.findall(r"sampling completed, taking ([\d.]+)s", log)
    if sampling:
        info["sampling_s"] = float(sampling[-1])
    return raw, info


def paste(view, raw, mask, preset, run):
    """Put only the area around the item back into the original picture.

    The image model redraws everything, so its output is pasted through a mask grown past the item
    (so shadows and reflections go too), after its tones are matched to the original at the border.
    A shadow can reach much further than that in one direction. The model's own picture shows where:
    the paste area also takes in the item's effect (metrics.effect_region), however far it runs.
    """
    target = Image.open(view).convert("RGB")
    out = Image.open(raw).convert("RGB").resize(target.size, Image.LANCZOS)
    item = Image.open(mask).convert("L")
    x0, y0, x1, y1 = item.getbbox()
    span = ((x1 - x0) + (y1 - y0)) / 2
    area = grow_mask(item, round(preset.paste_grow_pct / 100 * span / 2))
    effect, info = metrics.effect_region(target, out, np.asarray(item) > 127, preset.limits)
    Image.fromarray(effect.astype(np.uint8) * 255).save(run / "effect.png")
    if preset.follow_change and effect.any():
        near = np.asarray(area) > 0
        wider = metrics.grown(effect, round(0.025 * max(target.size)))    # past the soft edge of a shadow
        info["paste_added"] = round(float((wider & ~near).mean()), 4)
        area = Image.fromarray((near | wider).astype(np.uint8) * 255)
    inside = np.asarray(area) > 0
    shift = 0.0
    if preset.tone_match and inside.mean() < 0.85:           # needs some untouched picture to match against
        blur = ImageFilter.GaussianBlur(3)
        gap = np.asarray(target.filter(blur), np.float32) - np.asarray(out.filter(blur), np.float32)
        fix = membrane(gap, inside)
        out = Image.fromarray(np.clip(np.asarray(out, np.float32) + fix, 0, 255).astype(np.uint8))
        shift = round(float(np.abs(fix[inside]).mean()), 2)
    soft = area.filter(ImageFilter.GaussianBlur(max(2, round(preset.feather * max(target.size)))))
    edited, paste_mask = run / "edited.png", run / "paste_mask.png"
    Image.composite(out, target, soft).save(edited)
    area.save(paste_mask)
    return edited, paste_mask, {"tone_shift": shift, "paste_box": list(area.getbbox()), **info}


PLACE_PX = 512                                    # a place's crop is enlarged to this: 256 image tokens


def places(server, view, edited, regions, item, preset, run):
    """Ask what is inside each scouted place, on a crop of the original and on the same crop of the result.

    The place is marked with a red box. Each crop is one question, because the VLM describes one
    picture well and compares two badly (see PLACE_PROMPT). Returns the regions with both answers.
    """
    pictures = {"before": Image.open(view).convert("RGB"), "after": Image.open(edited).convert("RGB")}
    out, seconds = [], 0.0
    for n, region in enumerate(regions, 1):
        box = scout.crop_box(region["box"], pictures["before"].size)
        answers = {}
        for name, img in pictures.items():
            crop = img.crop(box)
            k = PLACE_PX / max(crop.size)
            crop = crop.resize((round(crop.size[0] * k), round(crop.size[1] * k)), Image.LANCZOS)
            x0, y0, x1, y1 = ((v - o) * k for v, o in zip(region["box"], box[:2] * 2))
            ImageDraw.Draw(crop).rectangle([x0 - 6, y0 - 6, x1 + 6, y1 + 6], outline=(255, 0, 0), width=3)
            path = run / f"place{n}_{name}.png"
            crop.save(path)
            answers[name], info = look(server, preset, [path], PLACE_PROMPT.format(item=item), PLACE_SCHEMA,
                                       max_tokens=120)
            seconds += info["answer_s"]
        out.append({**region, **answers})
    return out, round(seconds, 1)


def restore(view, edited, mask, boxes, out, limits):
    """Put the original's detail back in some boxes, in the tone the edit gave their surroundings.

    For something the edit removed by mistake: a baseboard, a frame. The original pixels alone would
    show as a patch wherever the edit changed the light (a lamp's glow went), so the smooth change the
    edit made around the boxes is added to them. The item itself is never brought back.

    A neighbour the model redrew that a box touches is taken back whole. Half original and half redrawn
    shows double (a wire table in front of the baseboard). If that grows past `restore_max_share` of
    the picture, only the boxes are restored. The area is saved next to `out` as `<name>_area.png`.
    """
    before, after = Image.open(view).convert("RGB"), Image.open(edited).convert("RGB")
    w, h = before.size
    long_side = max(w, h)
    pad = round(0.02 * long_side)
    area = np.zeros((h, w), bool)
    for x0, y0, x1, y1 in boxes:
        area[max(0, y0 - pad):y1 + pad, max(0, x0 - pad):x1 + pad] = True
    item = np.asarray(Image.open(mask).convert("L").resize((w, h))) > 127
    wider = scout.redrawn_with(before, after, area, limits)
    if wider.mean() <= limits.restore_max_share:
        area = wider
    area &= ~metrics.grown(item, round(0.01 * long_side))
    Image.fromarray(area.astype(np.uint8) * 255).save(Path(out).with_name(f"{Path(out).stem}_area.png"))
    b, a = np.asarray(before, np.float32), np.asarray(after, np.float32)
    keep = (~area & ~metrics.grown(item, pad)).astype(np.float32)        # the tone comes from around the boxes
    r = round(0.04 * long_side)
    weight = np.maximum(metrics.smooth(keep, r), 0.05)
    tone = np.stack([metrics.smooth((a - b)[..., c] * keep, r) / weight for c in range(3)], axis=2)
    restored = Image.fromarray(np.clip(b + tone, 0, 255).astype(np.uint8))
    soft = Image.fromarray(area.astype(np.uint8) * 255).filter(ImageFilter.GaussianBlur(max(2, round(0.006 * long_side))))
    Image.composite(restored, after, soft).save(out)
    return out


def inspect(server, view, edited, request, target, preset, run, also=None, regions=None):
    """Short questions with fixed answers, in one VLM session.

    1. Before and after, side by side: was the change applied, and was a neighbour damaged? It is
       given the user's own request, not the locator's rewrite of it, so that a bad rewrite is caught.
    After a removal, two more on a close-up of the result alone, where the VLM is more reliable:
    2. Which of the things can still be seen?
    3. Is there a patch, a shadow or a glow left on the wall or floor?
    `also` is a pixel box the close-up must take in as well: where the item's shadow or glow was.
    4. For each place the scout marked (`regions`): what is inside it, before and after?
    """
    boxes = np.array([b["bbox_2d"] for b in target["boxes"]])
    union = [int(v) for v in (*boxes[:, :2].min(axis=0), *boxes[:, 2:].max(axis=0))]
    text = COMPARE_PROMPT.format(request=request, item=target["item"], box=union)
    answer, info = look(server, preset, [view, edited], text, COMPARE_SCHEMA, max_tokens=300)
    result = Image.open(edited).convert("RGB")
    x0, y0, x1, y1 = to_pixels(union, result.size)
    answer["item_box"] = [x0, y0, x1, y1]
    if target["kind"] == "remove":
        mx, my = round(0.75 * (x1 - x0)), round(0.25 * (y1 - y0))            # room to see the surroundings
        close = [max(0, x0 - mx), max(0, y0 - my), min(result.size[0], x1 + mx), min(result.size[1], y1 + my)]
        if also:                                                              # and where its shadow or glow was
            pad = round(0.03 * max(result.size))
            close = [max(0, min(close[0], also[0] - pad)), max(0, min(close[1], also[1] - pad)),
                     min(result.size[0], max(close[2], also[2] + pad)), min(result.size[1], max(close[3], also[3] + pad))]
        crop = run / "inspect_crop.png"
        result.crop(close).save(crop)
        labels = list(dict.fromkeys(b["label"] for b in target["boxes"]))
        seen, info2 = look(server, preset, [crop], VISIBLE_PROMPT.format(labels=json.dumps(labels)),
                           visible_schema(labels), max_tokens=300)
        surface, info3 = look(server, preset, [crop], SURFACE_PROMPT, SURFACE_SCHEMA, max_tokens=300)
        answer.update(seen, **surface, close_box=close)
        info = {key: round(info[key] + info2[key] + info3[key], 1) for key in info}
    if regions:
        answer["places"], info["places_s"] = places(server, view, edited, regions, target["item"], preset, run)
    return answer, info

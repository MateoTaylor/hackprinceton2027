"""Retexture from a found.json (the finder's output, or written by hand).

  python -m edit_agent.change one  --input found.json [--preset 720] [--name N] [--change JSON]
  python -m edit_agent.change pans --input found.json [--variants auto | alone,chain,guide] [--max-views 4]

`one` edits the found view: change block (VLM) -> image model -> paste -> checks (numbers, one VLM
question) -> report.json and sheet.jpg in data/edit_agent/change/runs/<time>-<name>/.

`pans` does `one`, then every other panorama that sees the thing, once per variant:
  alone  the view on its own
  chain  plus the first view's result as image2
  guide  plus this view with the first view's result drawn in through the mesh, as image2
  auto   (the default) guide, or alone where the mesh carries less than MIN_GUIDE_FILL of the thing
and compares each view's result with the first view's at the surface points both see. Without a mesh
the other panoramas cannot be found or outlined, so only the found view is edited.
"""
import argparse
import json
import re
import time
from dataclasses import replace
from datetime import datetime
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

from edit_agent import gpu, steps
from edit_agent.change import checks, views, wording
from edit_agent.change import paste as paste_rule
from edit_agent.change.generate import generate, shrunk
from edit_agent.change.spec import Change, describe, label_of
from edit_agent.config import DEFAULT_PRESET, PRESETS, ROOT

RUNS = ROOT / "data" / "edit_agent" / "change" / "runs"
MIN_DISTANCE = 0.8        # metres from the thing; nearer panoramas only see a slab of it
MIN_GUIDE_FILL = 0.5      # share of the thing the guide must fill from the first result, or `auto` uses alone


def _bool(path):
    return np.asarray(Image.open(path).convert("L")) > 127


def _box(mask):
    ys, xs = np.nonzero(mask)
    return [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1]


def _tile(path, label, side=360):
    img = Image.open(path).convert("RGB")
    img = img.resize((side, round(side * img.size[1] / img.size[0])), Image.LANCZOS)
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, 8 + 6 * len(label), 16], fill=(0, 0, 0))
    d.text((4, 3), label, fill=(255, 255, 0))
    return img


def sheet(rows, path, side=360):
    tiles = [[_tile(p, label, side) for p, label in row if p] for row in rows]
    w = side * max(len(r) for r in tiles)
    h = sum(max(t.size[1] for t in r) for r in tiles)
    out = Image.new("RGB", (w, h), (30, 30, 30))
    y = 0
    for r in tiles:
        for i, t in enumerate(r):
            out.paste(t, (i * side, y))
        y += max(t.size[1] for t in r)
    out.save(path, quality=88)
    return path


def overlay(view, mask, path, colour=(255, 40, 40)):
    img = Image.open(view).convert("RGB")
    m = np.asarray(Image.open(mask).convert("L"), np.float32)[..., None] / 255 * 0.5
    a = np.asarray(img, np.float32)
    Image.fromarray((a * (1 - m) + np.array(colour, np.float32) * m).astype(np.uint8)).save(path)
    return path


def edit_view(view, mask, target, preset, run, request, refs=(), note="", tag="", ask_vlm=True):
    """Generate, paste and check one view whose target already has its change block."""
    t0 = time.time()
    prompt = wording.prompt(target) + note
    with gpu.exclusive():
        raw, ginfo = generate(view, prompt, preset, run, refs=refs, tag=f"raw{tag}")
    item = _bool(mask)
    outline, form = None, None
    if target["change"]["form"] == "small":
        outline, form = paste_rule.new_outline(raw, item, run)
    sub = run / (tag.strip("_") or "result")
    sub.mkdir(exist_ok=True)
    edited, pmask, pinfo = paste_rule.paste(view, raw, mask, target, preset, sub, outline)
    scores = checks.measure(view, raw, edited, mask, pmask, target, preset, sub, form, pinfo)
    scores.update({k: v for k, v in pinfo.items() if k not in scores})
    findings = {}
    if ask_vlm:
        with gpu.vlm(preset, log=run / "llama-server.log") as server:
            findings, _ = checks.inspect(server, preset, edited, target, pmask, sub)
    issues = checks.flags(scores, findings, target)
    return {"prompt": prompt, "raw": str(raw), "edited": str(edited), "paste_mask": str(pmask), "scores": scores,
            "findings": findings, "issues": issues, "generate": ginfo, "seconds": round(time.time() - t0, 1)}


def start(found, preset, name):
    label = name or re.sub(r"[^a-z0-9]+", "-", found["request"].lower()).strip("-")[:40]
    run = RUNS / f"{datetime.now():%Y%m%d-%H%M%S}-{label}"
    run.mkdir(parents=True)
    view, size = steps.prepare(found.get("image"), found.get("scan"), preset, run)
    given = found["target"]
    target = steps.adopt({**given, "kind": "change"}, view)          # Target drops `change`; it is added back below
    mask = steps.adopt_mask(found["mask"], view, preset, run)
    return run, view, target, mask, given.get("change")


def fill_change(view, mask, target, preset, run, request, given=None):
    if given:
        return Change.model_validate(given).block(), {"given": True}
    crop, _ = checks.close_up(view, _box(_bool(mask)), run, margin=0.4)
    with gpu.vlm(preset, log=run / "llama-server.log") as server:
        block, info = describe(server, preset, crop, request, target)
    return block, info


def _badness(result):
    """Fewer severity-3 issues first, then fewer severity-2 ones."""
    return (sum(i["severity"] >= 3 for i in result["issues"]), sum(i["severity"] == 2 for i in result["issues"]))


def one(args, retries=0):
    """`retries`: new seeds to try while the result has a severity-3 issue; the least bad result is kept.
    `pans` uses it, because every other view is measured against the first one."""
    found = json.loads(Path(args.input).read_text(encoding="utf-8"))
    preset = PRESETS[args.preset or found.get("preset") or DEFAULT_PRESET]
    run, view, target, mask, given = start(found, preset, args.name)
    target["change"], cinfo = fill_change(view, mask, target, preset, run, found["request"],
                                          json.loads(args.change) if args.change else given)
    print("change:", json.dumps(target["change"]))
    result = edit_view(view, mask, target, preset, run, found["request"])
    attempts = [(preset.seed, result)]
    for k in range(1, retries + 1):
        if _badness(result)[0] == 0:
            break
        seed = preset.seed + k
        print(f"first view: {[(i['kind'], i['severity']) for i in result['issues']]}; again with seed {seed}")
        attempts.append((seed, edit_view(view, mask, target, replace(preset, seed=seed), run, found["request"],
                                         tag=f"_seed{seed}")))
        result = min((r for _, r in attempts), key=_badness)
    record = {"request": found["request"], "scan": found.get("scan"), "view": str(view), "mask": str(mask),
              "target": {k: v for k, v in target.items() if k != "boxes"}, "change_info": cinfo, **result}
    if len(attempts) > 1:
        record["attempts"] = [{"seed": s, "edited": r["edited"], "issues": [(i["kind"], i["severity"]) for i in r["issues"]],
                               "kept": r is result} for s, r in attempts]
    (run / "report.json").write_text(json.dumps(record, indent=2, default=str), encoding="utf-8")
    sub = Path(result["edited"]).parent
    extra = [(sub / "colour_mask.png", "colour mask")] if (sub / "colour_mask.png").exists() else []
    sheet([[(view, "photo"), (result["raw"], "image model"), (result["edited"], "pasted")],
           [(overlay(view, mask, sub / "mask_overlay.png"), "mask"), *extra,
            (overlay(view, sub / "effect.png", sub / "effect_overlay.png", (40, 160, 255)), "model's light change")]],
          run / "sheet.jpg")
    _say(record, run)
    return run, record


def _say(record, run):
    s = record["scores"]
    keys = ("drift_outside", "change_inside", "shading", "detail", "hue_off", "old_left", "effect_share", "form_iou",
            "colour_share", "tone_shift")
    print("scores:", {k: s[k] for k in keys if k in s})
    print("vlm:", record.get("findings"))
    print("issues:", [(i["kind"], i["severity"], i["evidence"]) for i in record["issues"]] or "none")
    print(f"{record['seconds']} s; sheet: {run / 'sheet.jpg'}")


def pans(args):
    run, first = one(args, retries=getattr(args, "retries", 2))
    found = json.loads(Path(args.input).read_text(encoding="utf-8"))
    preset = PRESETS[args.preset or found.get("preset") or DEFAULT_PRESET]
    scan = found["scan"]
    target = {**first["target"], "boxes": []}
    item = views.lift_mask({**scan, "fov": scan.get("fov", 75)}, _bool(first["mask"]))
    if item is None:
        why = "the scan has no mesh" if views.search._mesh(scan["model"]) is None else "the thing is not on the mesh"
        print(f"{why}: only the found view is edited")
        (run / "pans.json").write_text(json.dumps({"first": scan, "single_view": why, "views": []}, indent=2),
                                       encoding="utf-8")
        return run, first, []
    keep = views.lift_keep({**scan, "fov": scan.get("fov", 75)}, _bool(first["mask"]), item)
    share = views.seen_share(scan["model"], item)
    seen = sorted((j for j, v in enumerate(share) if j != scan["pano"] and v >= args.min_seen), key=lambda j: -share[j])
    # A panorama right next to the thing frames a bare slab of it (the door from 0.26 m), which shows
    # neither its shape nor its texture, so it is skipped.
    near = getattr(args, "min_distance", MIN_DISTANCE)
    others = []
    for j in seen:
        vscan, dist = views.frame_on(scan["model"], j, item, preset.work_px)
        if dist < near:
            print(f"  pano {j}: {dist} m from the thing, too close, skipped")
        elif len(others) < args.max_views - 1:
            others.append((j, vscan, dist))
    print("share of the thing each panorama sees:", share, "-> also", [j for j, _, _ in others])
    name = label_of(first["target"])
    rows, table = [], []
    for j, vscan, dist in others:
        vdir = run / f"p{j}"
        vdir.mkdir()
        view, _ = steps.prepare(None, vscan, preset, vdir)
        mask, minfo = views.sam_mask(view, vscan, item, vdir, keep=keep)
        if mask is None:
            print(f"  pano {j}: the thing is hidden in the framed view, skipped ({minfo})")
            continue
        mask_path = paste_rule.save_mask(mask, vdir / "mask.png")
        matched = views.pairs(scan, _bool(first["mask"]), vscan, mask, Image.open(view).size)
        print(f"  pano {j}: mask from {minfo.get('mask_from')} (IoU with the mesh {minfo.get('iou_mesh')}), "
              f"{minfo.get('keep_cut', 0):.1%} cut as left out in the first view")
        row = [(view, f"pano {j} photo")]
        g, filled = None, None
        for asked in args.variants:
            variant, refs, note, extra = asked, (), "", {}
            if asked in ("guide", "auto") and g is None:
                g, filled = views.guide(view, vscan, mask, scan, first["edited"], vdir / "guide.png")
            if asked == "auto":
                variant = "guide" if filled >= MIN_GUIDE_FILL else "alone"
                extra["asked"] = "auto"
                print(f"  pano {j}: the guide fills {filled:.0%} of the thing -> {variant}")
            if variant == "chain":
                refs = [shrunk(first["edited"], vdir / "context_chain.png")]
            elif variant == "guide":
                refs = [shrunk(g, vdir / "context_guide.png")]
            if g is not None:
                extra["guide_filled"] = filled
            if refs:
                note = wording.context_note(variant, name, first["target"]["change"]["to"])
            res = edit_view(view, mask_path, target, preset, vdir, found["request"], refs=refs, note=note,
                            tag=f"_{variant}", ask_vlm=not args.no_vlm)
            agree = views.agreement(scan, first["view"], first["edited"], _bool(first["mask"]),
                                    vscan, view, res["edited"], mask, matched=matched)
            entry = {"pano": j, "variant": variant, "scan": vscan, "distance_m": dist, **minfo, **extra,
                     "agree": agree, "issues": [(i["kind"], i["severity"]) for i in res["issues"]],
                     "scores": {k: res["scores"].get(k) for k in ("drift_outside", "shading", "detail", "hue_off",
                                                                  "old_left", "effect_share")},
                     "seconds": res["seconds"], "sampling_s": res["generate"].get("sampling_s")}
            table.append(entry)
            row.append((res["edited"], f"pano {j} {variant}"))
            print(f"  pano {j} {variant}: agree {agree} issues {entry['issues']} {res['seconds']} s")
        if (vdir / "guide.png").exists():
            row.append((vdir / "guide.png", f"pano {j} guide input"))
        rows.append(row)
    (run / "pans.json").write_text(json.dumps({"first": scan, "share": share, "views": table}, indent=2, default=str),
                                   encoding="utf-8")
    sheet([[(first["view"], f"pano {scan['pano']} photo"), (first["edited"], "first view result")], *rows],
          run / "pans.jpg")
    print("sheet:", run / "pans.jpg")
    return run, first, table


def main():
    p = argparse.ArgumentParser(prog="python -m edit_agent.change")
    sub = p.add_subparsers(dest="cmd", required=True)
    for cmd in ("one", "pans"):
        s = sub.add_parser(cmd)
        s.add_argument("--input", required=True)
        s.add_argument("--preset")
        s.add_argument("--name")
        s.add_argument("--change", help="a change block as JSON, instead of asking the VLM")
        if cmd == "pans":
            s.add_argument("--variants", type=lambda v: v.split(","), default=["auto"],
                           help="auto (guide, or alone where the guide is mostly empty), or a list to compare")
            s.add_argument("--max-views", type=int, default=4)
            s.add_argument("--min-seen", type=float, default=0.3)
            s.add_argument("--no-vlm", action="store_true", help="skip the close-up question in the other views")
            s.add_argument("--retries", type=int, default=2, help="new seeds for a first view with a severity-3 issue")
            s.add_argument("--min-distance", type=float, default=MIN_DISTANCE, help="metres; closer panoramas are skipped")
    args = p.parse_args()
    {"one": one, "pans": pans}[args.cmd](args)


if __name__ == "__main__":
    main()

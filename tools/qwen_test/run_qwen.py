"""Run Qwen-Image-2.1 (stable-diffusion.cpp, GGUF weights) on a removal test case and time it.

  python run_qwen.py run --quant q4 [--variant plain] [--views 1 2 4] [--steps 20] [--seed 42]
  python run_qwen.py sheet                      comparison sheet of everything run so far
  python run_qwen.py grow [--pcts 0 20 50 100]  re-paste existing outputs with a larger paste mask

For each view it calls sd-cli once (so every call pays the model load), then pastes only the
masked region of the model's output back into the original crop (feathered), because
instruction-based editors redraw the whole image. Writes under outputs/<case>/<quant>_<variant>/:
  p<N>_raw.png        what the model returned
  p<N>_composite.png  original crop with only the masked area replaced
  p<N>.log            full sd-cli output
and appends one record per run to outputs/<case>/results.json.
"""
import argparse
import json
import re
import subprocess
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

HERE = Path(__file__).resolve().parent
MODELS = HERE / "models"
SD_CLI = HERE / "bin" / "sd" / "sd-cli.exe"

QUANTS = {
    "q4": {"diffusion": "qwen-image-2.1-Q4_K_M.gguf", "llm": "Qwen3-VL-8B-Instruct-UD-Q4_K_XL.gguf"},
    "q8": {"diffusion": "qwen-image-2.1-Q8_0.gguf", "llm": "Qwen3-VL-8B-Instruct-Q8_0.gguf"},
    # mixed pairings, to separate the effect of the image model from the text encoder
    "q8img_q4txt": {"diffusion": "qwen-image-2.1-Q8_0.gguf", "llm": "Qwen3-VL-8B-Instruct-UD-Q4_K_XL.gguf"},
}
VAE = "qwen_image_2.1_vae_bf16.safetensors"
VISION = "Qwen3-VL-8B-Instruct-mmproj-F16.gguf"
CONTEXT_PX = 768          # side of the extra context images in the `chain` variant (the crop to edit stays 1024)
VARIANTS = ["plain", "outlined", "refs", "prefill", "chain", "chain_both"]

PROMPTS = {
    "lamp_table": "Remove the table lamp and the small gold side table it stands on. "
                  "Show the empty white wall, the baseboard and the wood floor that are behind them. "
                  "Keep everything else in the image exactly the same.",
    "island_decor": "Remove the two white woven decorative balls with green vines from the granite countertop. "
                    "Show the empty countertop and what is behind them. "
                    "Keep everything else in the image exactly the same.",
    "corner_plant": "Remove the tall potted palm plant in the corner of the room behind the sofa. "
                    "Show the wall, the curtain and the window blinds that are behind it. "
                    "Keep the sofa, the cushions and everything else in the image exactly the same.",
    "sofa": "Remove the cream sofa and all the pillows on it. Show the empty floor, the baseboard and the wall "
            "behind it. Keep the painting, the plant, the curtain, the coffee table and everything else in the "
            "image exactly the same.",
    "sofa_pillows": "Change the colour of every teal (blue-green) pillow on the sofa to deep red. Keep each "
                    "pillow's shape, position, fabric pattern and shading. Keep the grey pillows, the sofa and "
                    "everything else in the image exactly the same.",
}


def prompt_for(case_dir, case):
    """The edit instruction: written by the VLM for agent cases (case.json "prompt"), else from PROMPTS."""
    meta = json.loads((case_dir / "case.json").read_text(encoding="utf-8"))
    return meta.get("prompt") or PROMPTS[case]


def shrunk(src, dst, side=CONTEXT_PX):
    Image.open(src).convert("RGB").resize((side, side), Image.LANCZOS).save(dst)
    return dst


def variant_inputs(case_dir, view, variant, work):
    """Reference images (in order) and prompt suffix for one variant."""
    tdir = case_dir / f"p{view}"
    if variant in ("chain", "chain_both"):
        # Views are edited in case.json order. Each view gets, as a separate smaller image, the model's
        # output for the already-edited view facing most nearly the same way, so invented content
        # agrees between panoramas. `chain_both` adds an unedited crop from the panorama that sees the
        # most of what the item hides.
        # The images are named image1, image2, ... because that is how the model's own prompt template
        # tags them. Calling them "the first image" and "the second image" made the model return the
        # already-edited view instead of editing this one (sofa_agent view 4, 3 of 3 runs).
        meta = json.loads((case_dir / "case.json").read_text(encoding="utf-8"))
        order = [t["pano"] for t in meta["targets"]]
        entry = meta["targets"][order.index(view)]
        earlier = [t for t in meta["targets"][:order.index(view)] if (work / f"p{t['pano']}_raw.png").exists()]
        images, notes = [tdir / "target.png"], []
        if earlier:
            facing = np.array(entry["camera"]["forward"])
            prev = max(earlier, key=lambda t: float(facing @ np.array(t["camera"]["forward"])))
            images.append(shrunk(work / f"p{prev['pano']}_raw.png", work / f"p{view}_context_edited.png"))
            notes.append("{tag} is a different photo of the same room, taken from another position after this edit "
                         "was made. Use {tag} only to see what the edited area looks like. Never copy the "
                         "viewpoint of {tag}.")
        if variant == "chain_both" and entry["refs"]:
            ref = tdir / "refs" / f"ref_p{entry['refs'][0]['pano']}.png"
            images.append(shrunk(ref, work / f"p{view}_context_unedited.png"))
            notes.append("{tag} is an unedited photo of the same room from another position, only to show what is "
                         "around and behind the object.")
        if not notes:
            return images, ""
        return images, (" Make this edit to image1 only. The result is image1 seen from image1's own camera "
                        "position." + "".join(" " + n.format(tag=f"image{i}") for i, n in enumerate(notes, start=2)))
    if variant == "plain":
        return [tdir / "target.png"], ""
    if variant == "outlined":          # target with the mask outlined in red, as a painted annotation
        img = Image.open(tdir / "target.png").convert("RGB")
        mask = Image.open(tdir / "mask.png").convert("L")
        edge = mask.filter(ImageFilter.MaxFilter(9)).point(lambda v: 255 if v else 0)
        ring = Image.fromarray(((np.asarray(edge) > 0) & ~(np.asarray(mask) > 0)).astype(np.uint8) * 255)
        img.paste((255, 0, 0), mask=ring)
        path = work / f"p{view}_outlined_input.png"
        img.save(path)
        return [path], " Remove what is inside the red outline, and remove the red outline too."
    if variant == "refs":              # target plus the best reference view from another panorama
        refs = sorted((tdir / "refs").glob("ref_p*.png"))
        meta = json.loads((case_dir / "case.json").read_text(encoding="utf-8"))
        entry = next(t for t in meta["targets"] if t["pano"] == view)
        best = tdir / "refs" / f"ref_p{entry['refs'][0]['pano']}.png" if entry["refs"] else refs[0]
        return [tdir / "target.png", best], (" Edit the first image. The second image shows the same corner "
                                             "from another position, for reference only.")
    if variant == "prefill":           # target plus the same view patched with real pixels from other panoramas
        return [tdir / "target.png", tdir / "prefill.png"], (
            " Edit the first image. The second image is a rough guide: it is the same view with the objects' "
            "area patched from photos taken at other positions, so it shows what is really behind the objects. "
            "It is blurry and slightly misaligned, and bright magenta marks areas nobody could see. Use it to "
            "decide what to draw in the cleared area, but do not copy its seams, blur or magenta.")
    raise SystemExit(f"unknown variant {variant}")


def known_background_error(case_dir, view, raw_path):
    """Mean absolute difference (0-255) between the model output and the real background, over the
    masked pixels where another panorama sees that background (the non-magenta part of the prefill).
    Also returns the share of the mask that is known. Exposure differs between panoramas, so compare
    variants on the same view rather than reading the number as an absolute error."""
    tdir = case_dir / f"p{view}"
    pre = np.asarray(Image.open(tdir / "prefill.png").convert("RGB"), np.float32)
    mask = np.asarray(Image.open(tdir / "mask.png").convert("L")) > 0
    raw = np.asarray(Image.open(raw_path).convert("RGB").resize(pre.shape[1::-1], Image.LANCZOS), np.float32)
    known = mask & ~((pre[..., 0] > 250) & (pre[..., 1] < 5) & (pre[..., 2] > 250))
    if not known.any():
        return None, 0.0
    return float(np.abs(raw - pre)[known].mean()), float(known.sum() / mask.sum())


class VramMonitor(threading.Thread):
    def __init__(self):
        super().__init__(daemon=True)
        self.peak = 0
        self.base = self._read()
        self._halt = threading.Event()

    @staticmethod
    def _read():
        try:
            out = subprocess.run(["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
                                 capture_output=True, text=True, timeout=5).stdout
            return int(out.strip().splitlines()[0])
        except Exception:
            return 0

    def run(self):
        while not self._halt.wait(0.5):
            self.peak = max(self.peak, self._read())

    def stop(self):
        self._halt.set()
        self.join()


def composite(target_path, mask_path, raw_path, out_path, feather=6):
    target = Image.open(target_path).convert("RGB")
    raw = Image.open(raw_path).convert("RGB").resize(target.size, Image.LANCZOS)
    mask = Image.open(mask_path).convert("L")
    soft = mask.filter(ImageFilter.GaussianBlur(feather))
    Image.composite(raw, target, soft).save(out_path)
    a, b = np.asarray(target, np.float32), np.asarray(raw, np.float32)
    outside = np.asarray(mask.filter(ImageFilter.MaxFilter(41))) == 0
    return float(np.abs(a - b)[outside].mean())      # how much the model changed pixels far from the mask


def run(args):
    case_dir = HERE / "cases" / args.case
    q = QUANTS[args.quant]
    out_dir = HERE / "outputs" / args.case / f"{args.quant}_{args.variant}"
    out_dir.mkdir(parents=True, exist_ok=True)
    results_path = HERE / "outputs" / args.case / "results.json"
    results = json.loads(results_path.read_text(encoding="utf-8")) if results_path.exists() else []
    for view in args.views:
        refs, suffix = variant_inputs(case_dir, view, args.variant, out_dir)
        raw = out_dir / f"p{view}_raw.png"
        cmd = [str(SD_CLI),
               "--diffusion-model", str(MODELS / q["diffusion"]),
               "--vae", str(MODELS / VAE),
               "--llm", str(MODELS / q["llm"]),
               "--llm_vision", str(MODELS / VISION)]
        for r in refs:
            cmd += ["-r", str(r)]
        prompt = prompt_for(case_dir, args.case) + suffix
        cmd += ["-p", prompt,
                "--cfg-scale", str(args.cfg), "--sampling-method", "euler", "--steps", str(args.steps),
                "-W", str(args.size), "-H", str(args.size), "--seed", str(args.seed),
                "--flash-attn", "off,diffusion=on", "-v", "-o", str(raw)]
        if args.offload:
            cmd.append("--offload-to-cpu")
        if args.variant.startswith("chain") and len(refs) > 1:
            # By default the runner enlarges every input image to the output size. This switch keeps the
            # context images at CONTEXT_PX, which is what saves time and GPU memory. No weights change.
            cmd += ["--ref-image-args", "resize_before_vae=0"]
        cmd += args.extra
        if raw.exists():
            raw.unlink()
        mon = VramMonitor()
        mon.start()
        t0 = time.time()
        proc = subprocess.run(cmd, capture_output=True, text=True, errors="replace")
        wall = time.time() - t0
        mon.stop()
        log = (f"PROMPT: {prompt}\nINPUTS: {[r.name for r in refs]}\n\n" + proc.stdout
               + "\n--- stderr ---\n" + proc.stderr)
        (out_dir / f"p{view}.log").write_text(log, encoding="utf-8")
        rec = {"quant": args.quant, "variant": args.variant, "view": view, "steps": args.steps, "cfg": args.cfg,
               "size": args.size, "seed": args.seed, "offload": args.offload, "wall_s": round(wall, 1),
               "vram_peak_mb": mon.peak, "vram_before_mb": mon.base, "exit": proc.returncode, "ok": raw.exists(),
               "inputs": [r.name for r in refs]}
        for key, pat in (("sampling_s", r"sampling completed, taking ([\d.]+)s"),
                         ("load_s", r"loading (?:model|tensors).*?taking ([\d.]+)s"),
                         ("total_s", r"generate_image completed in ([\d.]+)s"),
                         ("s_per_it", r"([\d.]+)s/it")):
            m = re.findall(pat, log)
            if m:
                rec[key] = float(m[-1])
        if raw.exists():
            rec["drift_outside_mask"] = round(composite(case_dir / f"p{view}" / "target.png",
                                                        case_dir / f"p{view}" / "mask.png",
                                                        raw, out_dir / f"p{view}_composite.png"), 2)
            err, share = known_background_error(case_dir, view, raw)
            if err is not None:
                rec["known_bg_error"], rec["known_bg_share"] = round(err, 1), round(share, 2)
        results = [r for r in results if (r["quant"], r["variant"], r["view"]) != (args.quant, args.variant, view)]
        results.append(rec)
        results_path.write_text(json.dumps(results, indent=2), encoding="utf-8")
        print(json.dumps(rec))
        if not raw.exists():
            print(log[-3000:])


def sheet(args):
    case_dir = HERE / "cases" / args.case
    root = HERE / "outputs" / args.case
    results = json.loads((root / "results.json").read_text(encoding="utf-8"))
    order = VARIANTS
    runs = sorted({(r["quant"], r["variant"]) for r in results if r["ok"] and (not args.quant or r["quant"] in args.quant)},
                  key=lambda qv: (qv[0], order.index(qv[1])))
    meta = json.loads((case_dir / "case.json").read_text(encoding="utf-8"))
    done = {r["view"] for r in results if r["ok"]}
    views = [t["pano"] for t in meta["targets"] if t["pano"] in done]
    tile = args.tile
    wide = args.composites                      # also show the mask-only paste next to each output
    step = 2 if wide else 1
    cols = 2 + step * len(runs)
    img = Image.new("RGB", (cols * tile, len(views) * tile), (24, 24, 24))

    def box(v):
        """With --zoom: a square around the mask, 25% wider than its longer side."""
        if not args.zoom:
            return None
        x0, y0, x1, y1 = Image.open(case_dir / f"p{v}" / "mask.png").convert("L").getbbox()
        half = 0.625 * max(x1 - x0, y1 - y0)
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        return tuple(round(c) for c in (cx - half, cy - half, cx + half, cy + half))

    def put(path, col, row, text):
        t = Image.open(path).convert("RGB")
        if t.size != (1024, 1024):
            t = t.resize((1024, 1024), Image.LANCZOS)
        t = t.resize((tile, tile), Image.LANCZOS, box=crop)
        d = ImageDraw.Draw(t)
        d.rectangle([0, 0, 8 + 7 * len(text), 20], fill=(0, 0, 0))
        d.text((5, 4), text, fill=(255, 255, 0))
        img.paste(t, (col * tile, row * tile))

    for row, v in enumerate(views):
        crop = box(v)
        put(case_dir / f"p{v}" / "target.png", 0, row, f"original, pano {v}")
        put(case_dir / f"p{v}" / "prefill.png", 1, row, "prefill: real pixels from other panos")
        for k, (quant, variant) in enumerate(runs):
            rec = next((r for r in results if (r["quant"], r["variant"], r["view"]) == (quant, variant, v) and r["ok"]), None)
            if not rec:
                continue
            d = root / f"{quant}_{variant}"
            secs = rec.get("sampling_s", rec["wall_s"])
            err = f", bg err {rec['known_bg_error']:.0f}" if "known_bg_error" in rec else ""
            put(d / f"p{v}_raw.png", 2 + step * k, row, f"{quant} {variant}: {secs:.0f} s{err}")
            if wide:
                put(d / f"p{v}_composite.png", 3 + step * k, row, f"{quant} {variant}: pasted into original")
    out = root / ("comparison_zoom.jpg" if args.zoom else "comparison.jpg")
    img.save(out, quality=90)
    print(out)


def grow_mask(mask, radius):
    """Dilate a mask by `radius` pixels (in steps, because large MaxFilter kernels are slow)."""
    out, left = mask, radius
    while left > 0:
        k = min(left, 15)
        out = out.filter(ImageFilter.MaxFilter(2 * k + 1))
        left -= k
    return out


def membrane(diff, inside, iters=(600, 300, 150, 80, 50)):
    """Smoothly extend `diff` (H x W x 3, known outside the mask) across the inside of the mask.

    Solves Laplace's equation inside the mask with the surrounding values of `diff` as the boundary
    (the correction term of Poisson blending), coarse to fine so the low frequencies converge.
    H and W must be divisible by 2 ** (len(iters) - 1).
    """
    levels = len(iters)
    pyramid = []
    for lv in range(levels):
        f = 2 ** (levels - 1 - lv)
        h, w = diff.shape[0] // f, diff.shape[1] // f
        ins = inside.reshape(h, f, w, f).any(axis=(1, 3))                      # a cell is unknown if any pixel is
        known = (~inside).reshape(h, f, w, f).astype(np.float32)
        total = (diff * (~inside)[..., None]).reshape(h, f, w, f, 3).sum(axis=(1, 3))
        value = total / np.maximum(known.sum(axis=(1, 3)), 1)[..., None]       # mean of the known pixels
        pyramid.append((ins, value.astype(np.float32)))
    u = None
    for (ins, value), n in zip(pyramid, iters):
        if u is None:
            u = np.where(ins[..., None], value[~ins].mean(axis=0), value).astype(np.float32)
        else:
            u = np.where(ins[..., None], u.repeat(2, axis=0).repeat(2, axis=1), value)
        for _ in range(n):                                                      # Jacobi relaxation
            p = np.pad(u, ((1, 1), (1, 1), (0, 0)), mode="edge")
            avg = (p[:-2, 1:-1] + p[2:, 1:-1] + p[1:-1, :-2] + p[1:-1, 2:]) / 4
            u = np.where(ins[..., None], avg, value)
    return u


def grow(args):
    """Re-paste existing model outputs with the paste mask grown by a percentage of its size.

    No model runs. 20% means every edge moves out by 10% of the mask's mean width/height.
    With --match, each size is also pasted with the model output tone-matched to the original
    along the mask border (see membrane()).
    """
    case_dir = HERE / "cases" / args.case
    root = HERE / "outputs" / args.case
    d = root / f"{args.quant}_{args.variant}"
    tile = args.tile
    per = 2 if args.match else 1
    img = Image.new("RGB", ((2 + per * len(args.pcts)) * tile, len(args.views) * tile), (24, 24, 24))
    blur = ImageFilter.GaussianBlur(3)          # compare tones, not texture the model redrew

    def put(im, col, row, text):
        t = im.resize((tile, tile), Image.LANCZOS)
        dr = ImageDraw.Draw(t)
        dr.rectangle([0, 0, 8 + 7 * len(text), 20], fill=(0, 0, 0))
        dr.text((5, 4), text, fill=(255, 255, 0))
        img.paste(t, (col * tile, row * tile))

    for row, v in enumerate(args.views):
        target = Image.open(case_dir / f"p{v}" / "target.png").convert("RGB")
        raw = Image.open(d / f"p{v}_raw.png").convert("RGB").resize(target.size, Image.LANCZOS)
        mask = Image.open(case_dir / f"p{v}" / "mask.png").convert("L")
        x0, y0, x1, y1 = mask.getbbox()
        span = ((x1 - x0) + (y1 - y0)) / 2
        put(target, 0, row, f"original, pano {v}")
        tone_gap = (np.asarray(target.filter(blur), np.float32) - np.asarray(raw.filter(blur), np.float32))
        for k, pct in enumerate(args.pcts):
            r = round(pct / 100 * span / 2)
            grown = grow_mask(mask, r)
            soft = grown.filter(ImageFilter.GaussianBlur(args.feather))
            comp = Image.composite(raw, target, soft)
            comp.save(d / f"p{v}_grow{pct}.png")
            share = 100 * (np.asarray(grown) > 0).mean()
            put(comp, 1 + per * k, row, f"mask +{pct}% (edge +{r} px, {share:.0f}% of crop)")
            if args.match:
                fix = membrane(tone_gap, np.asarray(grown) > 0)
                matched = Image.fromarray(np.clip(np.asarray(raw, np.float32) + fix, 0, 255).astype(np.uint8))
                comp = Image.composite(matched, target, soft)
                comp.save(d / f"p{v}_grow{pct}_matched.png")
                inside = np.asarray(grown) > 0
                put(comp, 2 + per * k, row, f"mask +{pct}%, tone-matched (mean shift {np.abs(fix[inside]).mean():.1f})")
        put(raw, 1 + per * len(args.pcts), row, f"{args.quant}: whole model output")
    out = root / f"grow_{args.quant}_{args.variant}{'_matched' if args.match else ''}.jpg"
    img.save(out, quality=90)
    print(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--case", default="lamp_table")
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--quant", choices=list(QUANTS), required=True)
    r.add_argument("--variant", default="plain", choices=VARIANTS)
    r.add_argument("--views", nargs="+", type=int, default=[1, 2, 4])
    r.add_argument("--steps", type=int, default=20)
    r.add_argument("--cfg", type=float, default=6.0)
    r.add_argument("--size", type=int, default=1024)
    r.add_argument("--seed", type=int, default=42)
    r.add_argument("--offload", action="store_true", help="pass --offload-to-cpu (needed when the files don't fit in VRAM together)")
    r.add_argument("extra", nargs=argparse.REMAINDER, help="extra sd-cli flags after --")
    s = sub.add_parser("sheet")
    s.add_argument("--tile", type=int, default=448)
    s.add_argument("--composites", action="store_true", help="also show the mask-only paste for each run")
    s.add_argument("--zoom", action="store_true", help="crop every tile to the area around the mask")
    s.add_argument("--quant", nargs="+", help="only these quantisations (default: all that ran)")
    g = sub.add_parser("grow")
    g.add_argument("--quant", choices=list(QUANTS), default="q8")
    g.add_argument("--variant", default="plain", choices=VARIANTS)
    g.add_argument("--views", nargs="+", type=int, default=[1, 2, 4])
    g.add_argument("--pcts", nargs="+", type=int, default=[0, 20, 50, 100])
    g.add_argument("--feather", type=float, default=6)
    g.add_argument("--match", action="store_true", help="also paste with tone matching at the mask border")
    g.add_argument("--tile", type=int, default=400)
    args = ap.parse_args()
    if args.cmd == "run":
        args.extra = [e for e in args.extra if e != "--"]
        run(args)
    elif args.cmd == "grow":
        grow(args)
    else:
        sheet(args)


if __name__ == "__main__":
    main()

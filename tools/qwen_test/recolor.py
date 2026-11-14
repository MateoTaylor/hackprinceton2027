"""Recolour by hue shift, with no image model: a deterministic alternative to asking Qwen.

  python -I recolor.py --case sofa_pillows --views 1 4 7 [--export]

A pixel is recoloured when (a) its ray hits the mesh inside the case's 3D item shape, so things in
front of or behind the item are left alone, and (b) its hue is in the --from range and it is
saturated enough. Only the hue changes; brightness and saturation, and so pattern and shading, stay.
It works on the cube faces directly, at full panorama resolution. The scan's files are not modified;
with --export the changed faces go to data/<model>/edits/<case>_hue/ for the viewer (key X).
Writes outputs/<case>/pano_paste/p<N>/hue_compare.jpg: original | model result (if pasted) | hue shift.
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np
from PIL import Image, ImageFilter

from build_case import Item
from pano import Camera, Scan
from paste_pano import export, label, paste, strip

HERE = Path(__file__).resolve().parent
STEP = 4            # the on-item test is ray cast every STEP pixels of the crop


def on_item_mask(mesh, item, cam, mask, margin=0.10):
    """Crop-space weight (0-1): 1 where the first mesh surface along the pixel's ray is inside the item."""
    rays = cam.rays()
    ys, xs = np.nonzero(mask[STEP // 2::STEP, STEP // 2::STEP])
    d = rays[ys * STEP + STEP // 2, xs * STEP + STEP // 2]
    t = mesh.cast(cam.pos, d)
    ok = np.isfinite(t)
    hit = np.zeros(len(t), bool)
    hit[ok] = item.inside(cam.pos + d[ok] * t[ok, None], margin=margin)
    coarse = np.zeros((cam.h // STEP, cam.w // STEP), np.uint8)
    coarse[ys[hit], xs[hit]] = 255
    img = Image.fromarray(coarse).resize((cam.w, cam.h), Image.BILINEAR).filter(ImageFilter.GaussianBlur(2))
    return np.asarray(img, np.float32)[..., None] / 255


def hue_shift(face, weight, lo, hi, to, min_sat):
    """face: H x W x 3 float (0-255). Returns the recoloured face and how many pixels changed."""
    hsv = np.asarray(Image.fromarray(np.clip(face, 0, 255).astype(np.uint8)).convert("HSV"), np.float32)
    hue = hsv[..., 0] * 360 / 255
    sat = hsv[..., 1] / 255
    pick = (hue >= lo) & (hue <= hi)
    w = pick * np.clip((sat - min_sat) / 0.10, 0, 1) * weight          # soft on saturation and at the item's edge
    w = np.asarray(Image.fromarray((w * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.8)), np.float32) / 255
    new = hsv.copy()
    new[..., 0] = to * 255 / 360
    rgb = np.asarray(Image.fromarray(new.astype(np.uint8), "HSV").convert("RGB"), np.float32)
    return face * (1 - w[..., None]) + rgb * w[..., None], int((w > 0.5).sum())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--case", default="sofa_pillows")
    ap.add_argument("--views", nargs="+", type=int, required=True)
    ap.add_argument("--from", dest="src", nargs=2, type=float, default=[150, 200], metavar=("LO", "HI"),
                    help="hue range to change, degrees (teal is about 175)")
    ap.add_argument("--to", type=float, default=355, help="new hue, degrees (red is 0 / 360)")
    ap.add_argument("--min-sat", type=float, default=0.25)
    ap.add_argument("--export", action="store_true")
    args = ap.parse_args()

    case_dir = HERE / "cases" / args.case
    meta = json.loads((case_dir / "case.json").read_text(encoding="utf-8"))
    scan = Scan(meta["model"])
    mesh = scan.mesh()
    item = Item(meta["item"])
    what = meta.get("label") or meta["what"].split(",")[0]
    for v in args.views:
        entry = next(t for t in meta["targets"] if t["pano"] == v)
        mask = np.asarray(Image.open(case_dir / f"p{v}" / "mask.png").convert("L")) > 0
        cam = Camera(entry["camera"]["pos"], entry["camera"]["forward"], entry["fov_deg"], mask.shape[1], mask.shape[0])
        weight = on_item_mask(mesh, item, cam, mask)
        original = scan.faces(v)
        # paste() maps crop space to the cube faces; pasting white onto black with `weight` gives the
        # weight of every face pixel
        blank = [np.zeros_like(f) for f in original]
        maps, touched = paste(blank, scan.rotation(v), cam, np.full((cam.h, cam.w, 3), 255, np.float32), weight)
        faces, changed, total = list(original), [], 0
        for k in touched:
            faces[k], n = hue_shift(original[k], maps[k][..., 0] / 255, *args.src, args.to, args.min_sat)
            if n:
                changed.append(k)
                total += n
        print(f"pano {v}: {total} pixels recoloured on faces {changed} ({100 * total / (6 * 2048 * 2048):.2f}% of the panorama)")
        if args.export:
            export(scan, v, f"{args.case}_hue", f"{what} (hue shift, no model)", faces, changed)

        out_dir = HERE / "outputs" / args.case / "pano_paste" / f"p{v}"
        out_dir.mkdir(parents=True, exist_ok=True)
        versions = [("original", original)]
        model = list(original)
        found = False
        for k in range(6):
            p = out_dir / f"plain_grow0_face{k}.png"
            if p.exists():
                model[k] = np.asarray(Image.open(p).convert("RGB"), np.float32)
                found = True
        if found:
            versions.append(("image model, pasted with the item mask", model))
        versions.append(("hue shift on item pixels, no model", faces))
        view_cam = Camera(cam.pos, cam.f, entry["fov_deg"] * 0.8, 900, 900)
        tiles = []
        for name, f in versions:
            scan._faces[v] = f
            tiles.append(label(scan.view(v, view_cam), f"pano {v}: {name}"))
        scan._faces[v] = original
        strip(tiles).save(out_dir / "hue_compare.jpg", quality=92)
        print(out_dir / "hue_compare.jpg")


if __name__ == "__main__":
    main()

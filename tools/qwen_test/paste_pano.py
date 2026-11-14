"""Write a pasted crop back into the panorama's cube faces (as copies) and render views from it.

  python -I paste_pano.py --view 1 [--quant q8] [--pcts 50 100]

Needs `run_qwen.py grow --match --pcts ...` to have been run for the same quant and percentages.
For every pixel of each cube face it takes the viewing direction, finds where that direction lands
in the 1024 px crop (same position as the panorama, so no parallax) and blends in the pasted colour
using the soft paste mask. The scan's own files under data/ are not modified; with --export the
changed faces are also written to data/<model>/edits/<case>_grow<pct>/ so the walk-through viewer
can show them (key X). Writes under
outputs/<case>/pano_paste/p<N>/:
  grow<pct>_face<k>.png     the changed cube faces
  wide.jpg                  100 degree view: original and each paste
  native.jpg                view at the panorama's own pixel density: original and each paste
  detail.jpg                floor and baseboard from native.jpg at 2x
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

from pano import FACE_F, FACE_R, FACE_U, Camera, Scan
from run_qwen import grow_mask

HERE = Path(__file__).resolve().parent


def bilinear(img, x, y):
    """Sample img (H x W x C float) at continuous pixel-centre coordinates."""
    h, w = img.shape[:2]
    x = np.clip(x, 0, w - 1)
    y = np.clip(y, 0, h - 1)
    x0 = np.minimum(x.astype(int), w - 2)
    y0 = np.minimum(y.astype(int), h - 2)
    fx, fy = (x - x0)[:, None], (y - y0)[:, None]
    return ((img[y0, x0] * (1 - fx) + img[y0, x0 + 1] * fx) * (1 - fy)
            + (img[y0 + 1, x0] * (1 - fx) + img[y0 + 1, x0 + 1] * fx) * fy)


def paste(faces, rot, cam, comp, alpha):
    """Copies of the cube faces with `comp` blended in by `alpha` (both in crop space). Returns faces, changed."""
    out, changed = [], []
    for k, face in enumerate(faces):
        h, w = face.shape[:2]
        gx, gy = np.meshgrid((np.arange(w) + 0.5) / w * 2 - 1, 1 - (np.arange(h) + 0.5) / h * 2)
        local = FACE_F[k] + gx[..., None] * FACE_R[k] + gy[..., None] * FACE_U[k]
        world = local.reshape(-1, 3) @ rot.T
        x, y, z = cam.project(cam.pos + world)
        ok = (z > 0) & (x >= 0) & (x <= cam.w) & (y >= 0) & (y <= cam.h)
        new = face.copy()
        if ok.any():
            idx = np.nonzero(ok)[0]
            a = bilinear(alpha, x[idx] - 0.5, y[idx] - 0.5)
            use = a[:, 0] > 0
            idx, a = idx[use], a[use]
            if idx.size:
                flat = new.reshape(-1, 3)
                flat[idx] = flat[idx] * (1 - a) + bilinear(comp, x[idx] - 0.5, y[idx] - 0.5) * a
                changed.append(k)
        out.append(new)
    return out, changed


def export(scan, v, name, text, faces, changed):
    """Add the changed faces to the edit set `name` under data/<model>/edits/ (read by the viewer, key X).

    Only new files are written, in the edits/ subfolder; the scan's own files are not touched.
    """
    edits = scan.dir / "edits"
    (edits / name).mkdir(parents=True, exist_ok=True)
    index_path = edits / "index.json"
    index = json.loads(index_path.read_text(encoding="utf-8")) if index_path.exists() else {"sets": []}
    entry = next((s for s in index["sets"] if s["name"] == name), None)
    if entry is None:
        entry = {"name": name, "label": text, "panos": {}}
        index["sets"].append(entry)
    loc_id = scan.locations[v]["id"]
    swaps = {}
    for k in changed:
        rel = f"{name}/{loc_id}_face{k}.jpg"
        Image.fromarray(np.clip(faces[k], 0, 255).astype(np.uint8)).save(edits / rel, quality=95)
        swaps[str(k)] = rel
    entry["panos"][loc_id] = swaps
    index_path.write_text(json.dumps(index, indent=2), encoding="utf-8")


def label(img, text):
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, 10 + 7 * len(text), 20], fill=(0, 0, 0))
    d.text((5, 4), text, fill=(255, 255, 0))
    return img


def strip(images):
    out = Image.new("RGB", (sum(i.width for i in images), max(i.height for i in images)), (24, 24, 24))
    x = 0
    for i in images:
        out.paste(i, (x, 0))
        x += i.width
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--case", default="lamp_table")
    ap.add_argument("--view", type=int, required=True)
    ap.add_argument("--quant", default="q8")
    ap.add_argument("--variants", nargs="+", default=["plain"],
                    help="model input variants to paste; each becomes its own version and edit set")
    ap.add_argument("--pcts", nargs="+", type=int, default=[50, 100])
    ap.add_argument("--feather", type=float, default=6)
    ap.add_argument("--detail", nargs=4, type=int, default=[312, 362, 712, 662], metavar=("X0", "Y0", "X1", "Y1"),
                    help="400x300 box of the 1024 px native view to enlarge in detail.jpg")
    ap.add_argument("--export", action="store_true",
                    help="also add the changed faces to an edit set under data/<model>/edits/ for the viewer")
    args = ap.parse_args()

    case_dir = HERE / "cases" / args.case
    meta = json.loads((case_dir / "case.json").read_text(encoding="utf-8"))
    entry = next(t for t in meta["targets"] if t["pano"] == args.view)
    v = args.view
    scan = Scan(meta["model"])
    mask = Image.open(case_dir / f"p{v}" / "mask.png").convert("L")
    cam = Camera(entry["camera"]["pos"], entry["camera"]["forward"], entry["fov_deg"], *mask.size)
    out_dir = HERE / "outputs" / args.case / "pano_paste" / f"p{v}"
    out_dir.mkdir(parents=True, exist_ok=True)

    original = scan.faces(v)
    rot = scan.rotation(v)
    x0, y0, x1, y1 = mask.getbbox()
    span = ((x1 - x0) + (y1 - y0)) / 2
    what = meta.get("label") or meta["what"].split(",")[0] + " removed"
    versions = [("original", original)]
    for variant in args.variants:
        src = HERE / "outputs" / args.case / f"{args.quant}_{variant}"
        tag = "" if variant == "plain" else f"_{variant}"          # plain keeps the older, shorter names
        for pct in args.pcts:
            grown = grow_mask(mask, round(pct / 100 * span / 2))
            alpha = np.asarray(grown.filter(ImageFilter.GaussianBlur(args.feather)), np.float32)[..., None] / 255
            comp = np.asarray(Image.open(src / f"p{v}_grow{pct}_matched.png").convert("RGB"), np.float32)
            faces, changed = paste(original, rot, cam, comp, alpha)
            for k in changed:
                Image.fromarray(np.clip(faces[k], 0, 255).astype(np.uint8)).save(out_dir / f"{variant}_grow{pct}_face{k}.png")
            if args.export:
                export(scan, v, f"{args.case}{tag}_grow{pct}", f"{what} ({variant} input), +{pct}% mask", faces, changed)
            px = sum(int((np.abs(faces[k] - original[k]).max(axis=2) > 0.5).sum()) for k in changed)
            print(f"pano {v} {variant} +{pct}%: faces changed {changed}, {px} face pixels ({100 * px / (6 * 2048 * 2048):.2f}% of the panorama)")
            versions.append((f"{variant}, +{pct}% tone-matched paste", faces))

    # the panorama's own pixel density: a 90 degree face is 2048 px, so 1024 px spans 2*atan(0.5)
    native_fov = float(np.degrees(2 * np.arctan(0.5)))
    wide_cam = Camera(cam.pos, cam.f, 100, 1200, 900)
    native_cam = Camera(cam.pos, cam.f, native_fov, 1024, 1024)
    wide, native, detail = [], [], []
    for name, faces in versions:
        scan._faces[v] = faces
        wide.append(label(scan.view(v, wide_cam), f"pano {v}: {name}"))
        n = scan.view(v, native_cam)
        detail.append(label(n.crop(args.detail).resize((800, 600), Image.NEAREST), f"{name}, 2x"))
        native.append(label(n, f"pano {v}: {name} (panorama pixel density)"))
    scan._faces[v] = original
    strip(wide).save(out_dir / "wide.jpg", quality=92)
    strip(native).save(out_dir / "native.jpg", quality=92)
    strip(detail).save(out_dir / "detail.jpg", quality=92)
    print(out_dir)


if __name__ == "__main__":
    main()

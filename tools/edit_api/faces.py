"""An edited view back into its panorama's cube faces. No GPU.

The edit graph renders a square view from a panorama's six faces (`pano.Scan.view`), edits it, and
says which pixels it changed (the paste mask, white = changed). This module does the reverse: every
face pixel is turned into a world direction, projected into the view's camera, and where it lands
under the mask the edit is blended in. The rest of each face stays the original, byte for byte in
pixels (the face is re-encoded only if it changed).

Faces are 2048 px over 90 degrees, a 720 px view over 70 is about half that density, so the edit is
upsampled. To keep the photo's own detail where the edit only shifted a tone, the face keeps its
high frequencies (face minus the view's upsampled original) in proportion to how little the edit
changed that pixel. Where the edit replaced something (a removed lamp), the edit's pixels are used.

Conventions are the scan contract's (AGENT_COMMS.md, Shared contracts), as implemented by
`tools/qwen_test/pano.py`, which is imported and not changed.

    python faces.py check <run_dir> [--out DIR]   paste a finished run and report how well it matches
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data"
sys.path.insert(0, str(ROOT / "tools" / "qwen_test"))
from pano import FACE_F, FACE_R, FACE_U, Camera, Scan, quat_to_matrix  # noqa: E402

FEATHER_PX = 3.0      # view pixels: the mask's edge fades out over about this much, outwards
DETAIL_T = 24.0       # 0-255: an edit that moved a pixel by this much or more replaces it outright
COARSE = 8            # face pixels between samples when looking for the part of a face the view covers
JPEG_Q = 95


def manifest(model_id: str) -> dict:
    return json.loads((DATA / model_id / "manifest.json").read_text(encoding="utf-8"))


def camera(location: dict, yaw: float, pitch: float, fov: float, size: tuple[int, int]) -> Camera:
    """The view's camera, as `edit_agent.steps.prepare` builds it (width, height = the picture's)."""
    return Camera.from_angles(location["position"], yaw, pitch, fov, size[0], size[1])


def _rgb(path_or_img, size=None) -> np.ndarray:
    img = path_or_img if isinstance(path_or_img, Image.Image) else Image.open(path_or_img)
    img = img.convert("RGB")
    if size and img.size != tuple(size):
        img = img.resize(tuple(size), Image.LANCZOS)
    return np.asarray(img, dtype=np.float32)


def alpha_map(mask_path, size, feather: float = FEATHER_PX) -> np.ndarray:
    """0-1 weight in view pixels: 1 on the mask, fading to 0 about `feather` px outside it."""
    m = Image.open(mask_path).convert("L")
    if m.size != tuple(size):
        m = m.resize(tuple(size), Image.BILINEAR)
    hard = np.asarray(m, dtype=np.float32) / 255.0
    if feather <= 0:
        return hard
    soft = np.asarray(m.filter(ImageFilter.GaussianBlur(feather)), dtype=np.float32) / 255.0
    return np.maximum(hard, np.clip(2.0 * soft, 0.0, 1.0))


def _sample(img: np.ndarray, x: np.ndarray, y: np.ndarray) -> np.ndarray:
    """Bilinear sample at continuous pixel coordinates (pixel i's centre is at i + 0.5)."""
    h, w = img.shape[:2]
    px = np.clip(x - 0.5, 0, w - 1.001)
    py = np.clip(y - 0.5, 0, h - 1.001)
    x0, y0 = px.astype(int), py.astype(int)
    fx, fy = px - x0, py - y0
    if img.ndim == 3:
        fx, fy = fx[..., None], fy[..., None]
    return ((img[y0, x0] * (1 - fx) + img[y0, x0 + 1] * fx) * (1 - fy)
            + (img[y0 + 1, x0] * (1 - fx) + img[y0 + 1, x0 + 1] * fx) * fy)


def _face_dirs(face: int, size: int, ys: np.ndarray, xs: np.ndarray, rot: np.ndarray) -> np.ndarray:
    """World directions through face pixel centres (rows ys, columns xs). Inverse of Scan.sample."""
    a = (xs + 0.5) / size * 2 - 1                    # along image right
    b = 1 - (ys + 0.5) / size * 2                    # along image up
    gx, gy = np.meshgrid(a, b)
    local = FACE_F[face] + gx[..., None] * FACE_R[face] + gy[..., None] * FACE_U[face]
    local /= np.linalg.norm(local, axis=-1, keepdims=True)
    return local @ rot.T                             # rot takes pano-local to world


def _project(cam: Camera, dirs: np.ndarray):
    x, y, z = cam.project(cam.pos + dirs)
    inside = (z > 1e-6) & (x >= 0) & (x < cam.w) & (y >= 0) & (y < cam.h)
    return x, y, inside


def paste_view(model_id: str, index: int, yaw: float, pitch: float, fov: float,
               view, edited, mask, out_dir: Path, base: dict[int, Path] | None = None,
               feather: float = FEATHER_PX, detail: float = DETAIL_T, prefix: str = "") -> dict:
    """Write new cube faces for panorama `index` of `model_id` with the edited view pasted in.

    `view`, `edited` and `mask` are paths (or PIL images for view/edited) of one size, the size the
    view was rendered at. `base` maps face numbers to faces already edited by an earlier view of the
    same panorama, so several views chain. Faces go to `out_dir/<prefix><n>.jpg`. Returns
    {"changed": [face numbers], "faces": {n: path}, "share": {n: share of the face changed}}.
    """
    loc = manifest(model_id)["locations"][index]
    model_dir = DATA / model_id
    ed = _rgb(edited)
    h, w = ed.shape[:2]
    vw = _rgb(view, (w, h))
    alpha = alpha_map(mask, (w, h), feather)
    reach = np.asarray(Image.fromarray((alpha > 0).astype(np.uint8) * 255)
                       .filter(ImageFilter.MaxFilter(9)), dtype=bool)      # coarse test must not miss thin masks
    cam = camera(loc, yaw, pitch, fov, (w, h))
    rot = quat_to_matrix(loc["rotation"])
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    base = base or {}
    result = {"changed": [], "faces": {}, "share": {}}

    for face in range(6):
        src = Path(base[face]) if face in base else model_dir / loc["faces"][face]
        with Image.open(src) as im:
            size = im.size[0]
        # Which part of this face can the view touch at all? Coarse grid first.
        grid = np.arange(0, size, COARSE)
        x, y, inside = _project(cam, _face_dirs(face, size, grid, grid, rot))
        hit = np.zeros_like(inside)
        xi = np.clip(x.astype(int), 0, w - 1)
        yi = np.clip(y.astype(int), 0, h - 1)
        hit[inside] = reach[yi[inside], xi[inside]]
        if not hit.any():
            continue
        rows, cols = np.nonzero(hit)
        r0, r1 = max(0, grid[rows.min()] - COARSE), min(size, grid[rows.max()] + 2 * COARSE)
        c0, c1 = max(0, grid[cols.min()] - COARSE), min(size, grid[cols.max()] + 2 * COARSE)

        x, y, inside = _project(cam, _face_dirs(face, size, np.arange(r0, r1), np.arange(c0, c1), rot))
        a = np.where(inside, _sample(alpha, x, y), 0.0).astype(np.float32)
        if not (a > 1e-3).any():
            continue
        orig = _rgb(src)
        patch = orig[r0:r1, c0:c1]
        e_up, v_up = _sample(ed, x, y), _sample(vw, x, y)
        moved = np.abs(e_up - v_up).mean(axis=-1, keepdims=True)
        keep = np.clip(1.0 - moved / detail, 0.0, 1.0) if detail > 0 else 0.0
        new = e_up + keep * (patch - v_up)              # where the edit barely moved, this is the photo
        a3 = a[..., None]
        orig[r0:r1, c0:c1] = patch * (1 - a3) + new * a3
        dest = out_dir / f"{prefix}{face}.jpg"
        Image.fromarray(np.clip(orig + 0.5, 0, 255).astype(np.uint8)).save(dest, quality=JPEG_Q)
        result["changed"].append(face)
        result["faces"][face] = dest
        result["share"][face] = float((a > 0.5).sum()) / (size * size)
    return result


def render(model_id: str, index: int, yaw: float, pitch: float, fov: float, size,
           faces: dict[int, Path] | None = None) -> Image.Image:
    """The view rendered again, from the original faces with `faces` swapped in."""
    scan = Scan(model_id)
    if faces:
        loc = scan.locations[index]
        paths = [Path(faces[n]) if n in faces else scan.dir / loc["faces"][n] for n in range(6)]
        scan._faces[index] = [np.asarray(Image.open(p).convert("RGB"), dtype=np.float32) for p in paths]
    cam = Camera.from_angles(scan.position(index), yaw, pitch, fov, size[0], size[1])
    return scan.view(index, cam)


# ---------------------------------------------------------------- finished runs on disk

def run_paths(run_dir: Path) -> dict | None:
    """The pieces of a finished scan run: scan view, before, edited, paste mask, report. None if the
    run did not come from a scan or is missing a piece."""
    run_dir = Path(run_dir)
    rep_path = run_dir / "report.json"
    if not rep_path.is_file():
        return None
    rep = json.loads(rep_path.read_text(encoding="utf-8"))
    scan = rep.get("scan")
    if not scan or not rep.get("edited"):
        return None
    edited = Path(rep["edited"])
    mask = Path(rep["paste_mask"]) if rep.get("paste_mask") else None
    if mask is None or not mask.is_file():
        numbered = sorted(run_dir.glob("paste_mask_*.png"), key=lambda p: int(p.stem.rsplit("_", 1)[1]))
        mask = numbered[-1] if numbered else run_dir / "paste_mask.png"
    view = Path(rep.get("view") or run_dir / "view.png")
    if not (edited.is_file() and mask.is_file() and view.is_file()):
        return None
    return {"scan": scan, "view": view, "edited": edited, "mask": mask, "report": rep}


def check(run_dir: Path, out: Path) -> dict:
    """Paste a finished run into faces, render the view again from them, and measure the match."""
    p = run_paths(run_dir)
    if p is None:
        raise SystemExit(f"{run_dir}: not a finished scan run")
    s = p["scan"]
    res = paste_view(s["model"], s["pano"], s.get("yaw", 0), s.get("pitch", 0), s.get("fov", 75),
                     p["view"], p["edited"], p["mask"], out / "faces")
    ed = Image.open(p["edited"]).convert("RGB")
    again = render(s["model"], s["pano"], s.get("yaw", 0), s.get("pitch", 0), s.get("fov", 75), ed.size, res["faces"])
    again.save(out / "rerender.png")
    m = np.asarray(Image.open(p["mask"]).convert("L").resize(ed.size), dtype=np.float32) / 255 > 0.5
    a, e, v = (np.asarray(i, dtype=np.float32) for i in (again, ed, Image.open(p["view"]).convert("RGB")))
    inner = np.asarray(Image.fromarray(m.astype(np.uint8) * 255).filter(ImageFilter.MinFilter(7))) > 0
    outer = ~np.asarray(Image.fromarray(m.astype(np.uint8) * 255).filter(ImageFilter.MaxFilter(15))) > 0
    stats = {
        "changed_faces": res["changed"],
        "share": {k: round(v_, 4) for k, v_ in res["share"].items()},
        "mask_share": round(float(m.mean()), 4),
        "inside_vs_edited": round(float(np.abs(a - e)[inner].mean()), 2),
        "inside_view_vs_edited": round(float(np.abs(v - e)[inner].mean()), 2),
        "outside_vs_view": round(float(np.abs(a - v)[outer].mean()), 2),
    }
    strip = Image.new("RGB", (ed.width * 3, ed.height))
    for k, im in enumerate((Image.open(p["view"]).convert("RGB"), ed, again)):
        strip.paste(im, (k * ed.width, 0))
    strip.save(out / "view_edited_rerender.jpg", quality=90)
    return stats


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("check")
    c.add_argument("run_dir", type=Path)
    c.add_argument("--out", type=Path, default=None)
    args = ap.parse_args()
    out = args.out or DATA / "edit_api" / "checks" / args.run_dir.name
    out.mkdir(parents=True, exist_ok=True)
    print(json.dumps(check(args.run_dir, out), indent=1))
    print(f"wrote {out}")

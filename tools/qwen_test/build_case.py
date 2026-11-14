"""Build an item-removal test case from a downloaded scan: target crops, masks and reference views.

  python build_case.py [--case lamp_table]

For each target panorama it writes, under cases/<case>/p<index>/ (git-ignored):
  target.png        1024x1024 perspective crop aimed at the item
  mask.png          white = remove (the item's 3D outline projected into this view, dilated)
  preview.jpg       the crop with the mask tinted
  prefill.png       the masked area filled with real pixels from other panoramas where they can
                    see the background; magenta = no panorama sees it (must be generated)
  refs/ref_p<j>.png crops from the other panoramas that see the most hidden background
plus cases/<case>/review.jpg (everything on one sheet) and case.json (numbers and camera poses).

The item is described in 3D once (stacked vertical cylinders), so every view's mask comes from
the same shape. "Hidden background" is found by ray casting the mesh with the item's triangles
removed; whether another panorama sees a background point is tested against the cylinders
(the item) and the rest of the mesh (everything else).
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))   # so `python -I` still finds pano.py

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

from pano import Camera, Scan

HERE = Path(__file__).resolve().parent

CASES = {
    "lamp_table": {
        "model": "zzvymDx5ty7",
        "what": "table lamp and the side table it stands on, living-room corner",
        "center_xy": [-2.48, -4.02],
        # (radius m, z bottom m, z top m): side table, glass lamp base, lamp shade
        "parts": [[0.27, -0.02, 0.70], [0.16, 0.66, 1.12], [0.25, 1.05, 1.40]],
        # 0-based panorama indices to edit: front view, far oblique view, close-up from above.
        # Pano 0 also sees the lamp but through the kitchen faucet; masks don't handle occluders yet.
        "targets": [1, 2, 4],
        "max_refs": 3,
    },
    # No wall behind: seen from the living room, the hallway and the kitchen, with a different
    # background each time (cabinets and stove, doors, sofa). Other panoramas see most of it.
    "island_decor": {
        "model": "zzvymDx5ty7",
        "what": "two woven decorative balls on the kitchen island",
        "center_xy": [-0.76, -3.15],
        # a part may carry its own centre: (radius, z bottom, z top, x, y). The counter top is at
        # z = 0.91; the parts start above it so the counter stays part of the background.
        "parts": [[0.15, 0.95, 1.12, -0.74, -3.36], [0.13, 0.95, 1.10, -0.776, -2.947]],
        "targets": [4, 1, 0],
        "max_refs": 3,
        "fill": 0.4,            # smaller in the crop, so a +100% paste mask stays inside it
        "tri_margin": 0.02,
    },
    # Occluded: the pot and lower trunk are hidden behind the sofa and its cushions; thin leaves in
    # front of a curtain and window blinds.
    "corner_plant": {
        "model": "zzvymDx5ty7",
        "what": "tall potted plant in the corner behind the sofa",
        "center_xy": [-2.42, -7.45],
        "parts": [[0.22, 0.02, 0.60], [0.42, 0.55, 2.30]],      # pot, trunk and fronds
        "targets": [4, 1, 7],
        "max_refs": 3,
        "fill": 0.5,
        "tri_margin": -0.08,    # the corner walls are close; don't remove them with the plant
    },
}

# A large item, described as an axis-aligned box [x0, x1, y0, y1, z0, z1]. It stops short of the wall
# (x = -3.05) and the floor so those stay part of the background. The same shape is used twice: once
# to remove the sofa, once to recolour the pillows on it (the mask only says where to paste back).
SOFA = {
    "model": "zzvymDx5ty7",
    "center_xy": [-2.47, -6.28],
    "parts": [],
    "boxes": [[-2.98, -1.90, -7.62, -4.93, 0.04, 1.04]],
    "targets": [1, 4, 7],      # front, close and oblique, end-on through the hallway
    "max_refs": 3,
    "fill": 0.6,               # large item: keep resolution, and paste with a +50% mask instead of +100%
    "tri_margin": 0.0,
}
CASES["sofa"] = {**SOFA, "what": "sofa with its cushions, living room"}
CASES["sofa_pillows"] = {**SOFA, "what": "teal pillows on the sofa", "label": "teal sofa pillows recoloured red"}

SIZE = 1024
DILATE_PX = 12
COARSE = 8            # background depth is ray cast every COARSE pixels inside the mask
MAGENTA = np.array([255, 0, 255], np.float32)


def hull(points):
    pts = sorted(set(map(tuple, np.round(points, 2))))
    if len(pts) < 3:
        return pts
    def half(seq):
        out = []
        for p in seq:
            while len(out) >= 2 and ((out[-1][0] - out[-2][0]) * (p[1] - out[-2][1])
                                     - (out[-1][1] - out[-2][1]) * (p[0] - out[-2][0])) <= 0:
                out.pop()
            out.append(p)
        return out[:-1]
    return half(pts) + half(reversed(pts))


class Item:
    def __init__(self, spec):
        cx, cy = spec["center_xy"]
        # (radius, z bottom, z top, x, y); x, y default to the item's centre
        self.parts = [(p[0], p[1], p[2], *(p[3:5] if len(p) >= 5 else (cx, cy))) for p in spec["parts"]]
        self.boxes = [tuple(b) for b in spec.get("boxes", [])]      # (x0, x1, y0, y1, z0, z1)
        z0 = min([p[1] for p in self.parts] + [b[4] for b in self.boxes])
        z1 = max([p[2] for p in self.parts] + [b[5] for b in self.boxes])
        self.center = np.array([cx, cy, (z0 + z1) / 2])

    def inside(self, pts, margin=0.0):
        z = pts[..., 2]
        res = np.zeros(pts.shape[:-1], bool)
        for r, z0, z1, cx, cy in self.parts:
            d = np.hypot(pts[..., 0] - cx, pts[..., 1] - cy)
            res |= (d <= r + margin) & (z >= z0 - margin) & (z <= z1 + margin)
        x, y = pts[..., 0], pts[..., 1]
        for x0, x1, y0, y1, z0, z1 in self.boxes:
            res |= ((x >= x0 - margin) & (x <= x1 + margin) & (y >= y0 - margin) & (y <= y1 + margin)
                    & (z >= z0 - margin) & (z <= z1 + margin))
        return res

    def mask(self, cam, dilate=DILATE_PX):
        img = Image.new("L", (cam.w, cam.h), 0)
        draw = ImageDraw.Draw(img)
        ang = np.linspace(0, 2 * np.pi, 64, endpoint=False)
        for r, z0, z1, cx, cy in self.parts:
            ring = np.stack([cx + r * np.cos(ang), cy + r * np.sin(ang)], 1)
            pts = np.concatenate([np.c_[ring, np.full(len(ang), z)] for z in (z0, z1)])
            x, y, depth = cam.project(pts)
            if (depth <= 0.05).any():
                continue
            poly = hull(np.c_[x, y])
            if len(poly) >= 3:
                draw.polygon(poly, fill=255)
        for x0, x1, y0, y1, z0, z1 in self.boxes:
            pts = np.array([[x, y, z] for x in (x0, x1) for y in (y0, y1) for z in (z0, z1)])
            x, y, depth = cam.project(pts)
            if (depth <= 0.05).any():
                continue
            poly = hull(np.c_[x, y])
            if len(poly) >= 3:
                draw.polygon(poly, fill=255)
        return img.filter(ImageFilter.MaxFilter(2 * dilate + 1)) if dilate else img

    def blocks(self, origin, pts, samples=120):
        """True where the straight line from origin to each point passes through the item."""
        s = np.linspace(0.0, 1.0, samples, endpoint=False)[None, :, None]
        seg = origin[None, None, :] + s * (pts[:, None, :] - origin[None, None, :])
        return self.inside(seg, margin=0.02).any(1)


def frame(item, pos, size=SIZE, fill=0.6, max_fov=115.0):
    """Camera at `pos` centred on the item's outline, zoomed so the outline spans `fill` of the crop."""
    cam = Camera.looking_at(pos, item.center, 60, size, size)
    for _ in range(6):
        ys, xs = np.nonzero(np.asarray(item.mask(cam, dilate=0)))
        if not len(xs):
            break
        cx, cy = (xs.min() + xs.max()) / 2, (ys.min() + ys.max()) / 2
        extent = max(xs.max() - xs.min(), ys.max() - ys.min()) + 1
        forward = cam.f + (cx - size / 2) / cam.focal * cam.r - (cy - size / 2) / cam.focal * cam.u
        focal = cam.focal * fill * size / extent
        fov = min(max_fov, 2 * np.degrees(np.arctan(size / 2 / focal)))
        cam = Camera(pos, forward, fov, size, size)
    return cam, float(np.linalg.norm(item.center - pos))


def label(img, text):
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, 8 + 7 * len(text), 20], fill=(0, 0, 0))
    d.text((5, 4), text, fill=(255, 255, 0))
    return img


def build_target(scan, mesh, item, item_tris, ti, cam, dist, mask_img, tdir, max_refs=3, ref_fill=0.5):
    """Write one target view (crop, mask, preview, prefill, reference crops) into `tdir`.

    `item` needs inside(), blocks() and mask() (an Item here, or a VoxelItem from lift.py); `mask_img`
    is the removal mask for this view. Returns the case.json entry and the tiles for the review sheet.
    """
    tpos = scan.position(ti)
    fov = cam.fov
    target = np.asarray(scan.view(ti, cam), np.float32)
    mask = np.asarray(mask_img) > 0

    # Hidden background: cast every COARSE-th masked pixel against the mesh without the item.
    rays = cam.rays()
    ys, xs = np.nonzero(mask[COARSE // 2::COARSE, COARSE // 2::COARSE])
    py, px = ys * COARSE + COARSE // 2, xs * COARSE + COARSE // 2
    d = rays[py, px]
    t = mesh.cast(tpos, d, skip=item_tris)
    ok = np.isfinite(t) & (t < 9.0)
    bg = tpos + d[ok] * t[ok, None]
    py, px = py[ok], px[ok]

    # Which other panoramas see those background points?
    cands = []
    for j in range(len(scan)):
        if j == ti:
            continue
        jpos = scan.position(j)
        v = bg - jpos
        dj = np.linalg.norm(v, axis=1)
        tj = mesh.cast(jpos, v / dj[:, None], skip=item_tris)
        seen = (tj >= dj - 0.10) & ~item.blocks(jpos, bg)
        cands.append({"pano": j, "seen": seen, "dist": dj, "coverage": float(seen.mean()) if len(bg) else 0.0})
    cands.sort(key=lambda c: -c["coverage"])
    refs = [c for c in cands if c["coverage"] >= 0.03][:max_refs]

    # Prefill: per coarse sample take the reference that sees it from closest, then upsample.
    gh, gw = SIZE // COARSE, SIZE // COARSE
    depth = np.full((gh, gw), np.nan, np.float32)
    depth[ys[ok], xs[ok]] = t[ok]
    src = np.full((gh, gw), -1, np.int32)
    best = np.full(len(bg), np.inf)
    for c in refs:
        take = c["seen"] & (c["dist"] < best)
        best[take] = c["dist"][take]
        src[ys[ok][take], xs[ok][take]] = c["pano"]
    fill_depth = np.where(np.isnan(depth), np.nanmedian(depth) if ok.any() else 3.0, depth)
    dense_t = np.asarray(Image.fromarray(fill_depth).resize((SIZE, SIZE), Image.BILINEAR))
    dense_src = np.asarray(Image.fromarray(src).resize((SIZE, SIZE), Image.NEAREST))
    world = tpos + rays * dense_t[..., None]
    prefill = target.copy()
    prefill[mask] = MAGENTA
    for c in refs:
        m = mask & (dense_src == c["pano"])
        if m.any():
            v = world[m] - scan.position(c["pano"])
            prefill[m] = scan.sample(c["pano"], v / np.linalg.norm(v, axis=1, keepdims=True))
    any_seen = np.zeros(len(bg), bool)
    for c in refs:
        any_seen |= c["seen"]

    (tdir / "refs").mkdir(parents=True, exist_ok=True)
    for old in (tdir / "refs").glob("*.png"):
        old.unlink()
    Image.fromarray(target.astype(np.uint8)).save(tdir / "target.png")
    mask_img.save(tdir / "mask.png")
    tint = target.copy()
    tint[mask] = tint[mask] * 0.45 + np.array([255, 40, 40], np.float32) * 0.55
    preview = Image.fromarray(tint.astype(np.uint8))
    preview.save(tdir / "preview.jpg", quality=92)
    prefill_img = Image.fromarray(np.clip(prefill, 0, 255).astype(np.uint8))
    prefill_img.save(tdir / "prefill.png")

    ref_meta, ref_imgs = [], []
    for c in refs:
        j = c["pano"]
        jpos = scan.position(j)
        jcam, jdist = frame(item, jpos, fill=ref_fill)
        jfov = jcam.fov
        img = scan.view(j, jcam)
        img.save(tdir / "refs" / f"ref_p{j}.png")
        ref_imgs.append((img, f"reference: pano {j}, {jdist:.1f} m, sees {c['coverage']:.0%} of hidden area"))
        ref_meta.append({"pano": j, "distance_m": round(jdist, 2), "fov_deg": round(jfov, 1),
                         "hidden_background_seen": round(c["coverage"], 3)})

    entry = {
        "pano": ti, "distance_m": round(dist, 2), "fov_deg": round(fov, 1),
        "camera": {"pos": tpos.round(4).tolist(), "forward": cam.f.round(5).tolist()},
        "mask_fraction": round(float(mask.mean()), 4),
        "background_samples": int(len(bg)),
        "hidden_background_seen_by_any_ref": round(float(any_seen.mean()) if len(bg) else 0.0, 3),
        "refs": ref_meta,
        "all_panos_coverage": {str(c["pano"]): round(c["coverage"], 3) for c in cands},
    }
    print(f"  target pano {ti}: {dist:.2f} m, fov {fov:.0f} deg, mask {mask.mean():.1%} of crop, "
          f"refs {[(m['pano'], m['hidden_background_seen']) for m in ref_meta]}, "
          f"any ref sees {entry['hidden_background_seen_by_any_ref']:.0%}; "
          f"{len(bg)} background samples, all panos {entry['all_panos_coverage']}")

    tiles = [(Image.fromarray(target.astype(np.uint8)), f"TARGET pano {ti}, {dist:.1f} m, fov {fov:.0f}"),
             (preview, f"mask = {mask.mean():.1%} of the crop"),
             (prefill_img, f"real pixels from refs ({entry['hidden_background_seen_by_any_ref']:.0%}); magenta = unseen")]
    return entry, tiles + ref_imgs


def review_sheet(rows, path, tile=448):
    cols = max(len(r) for r in rows)
    sheet = Image.new("RGB", (cols * tile, len(rows) * tile), (24, 24, 24))
    for r, row in enumerate(rows):
        for c, (img, text) in enumerate(row):
            sheet.paste(label(img.resize((tile, tile), Image.LANCZOS), text), (c * tile, r * tile))
    sheet.save(path, quality=90)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--case", default="lamp_table", choices=list(CASES))
    args = ap.parse_args()
    spec = CASES[args.case]
    scan = Scan(spec["model"])
    mesh = scan.mesh()
    item = Item(spec)
    item_tris = item.inside(mesh.centroid, margin=spec.get("tri_margin", 0.06))
    fill = spec.get("fill", 0.6)
    out_dir = HERE / "cases" / args.case
    out_dir.mkdir(parents=True, exist_ok=True)
    print(f"case {args.case}: {spec['what']}; {int(item_tris.sum())} mesh triangles belong to the item")

    report = {"case": args.case, "model": spec["model"], "what": spec["what"], "label": spec.get("label"),
              "item": spec, "targets": []}
    rows = []
    for ti in spec["targets"]:
        cam, dist = frame(item, scan.position(ti), fill=fill)
        entry, tiles = build_target(scan, mesh, item, item_tris, ti, cam, dist, item.mask(cam), out_dir / f"p{ti}",
                                    max_refs=spec["max_refs"], ref_fill=min(0.5, fill))
        report["targets"].append(entry)
        rows.append(tiles)

    review_sheet(rows, out_dir / "review.jpg")
    (out_dir / "case.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(out_dir / "review.jpg")


if __name__ == "__main__":
    main()

"""Every panorama that sees the thing: a view framed on it, its mask there, and pixels carried
between views through the scan mesh.

The thing is lifted to the mesh once, as 5 cm voxels (qwen_test lift.py), from its mask in the first
view. Each other panorama gets a square view framed on the voxels (build_case.frame), a mask from the
mesh sharpened by SAM, and, for the `guide` variant, the first view's result drawn into its own
viewpoint. Two views are compared at the surface points both of them see.
"""
import numpy as np
from PIL import Image

from build_case import frame
from edit_agent.change import colour
from edit_agent.find import search
from edit_agent.find.common import sam
from lift import VoxelItem, grow, hit_points, main_parts, shrink, spread
from pano import Camera

MIN_FOV = 35.0            # zooming further into a panorama only enlarges its pixels
SEE_TOL = 0.03            # metres: a point counts as seen from a camera when the mesh hit is this close to it


def camera(scan, size):
    s = search._scan(scan["model"])
    return Camera.from_angles(s.position(scan["pano"]), scan.get("yaw", 0), scan.get("pitch", 0),
                              scan.get("fov", 75), size[0], size[1])


def angles(cam):
    f = cam.f
    return float(np.degrees(np.arctan2(f[1], f[0])) % 360), float(np.degrees(np.arcsin(np.clip(f[2], -1, 1))))


def lift_mask(scan, mask, step=2):
    """The thing as voxels: mesh hits through its mask, eroded so that rays at the edge do not slip
    past it, with stray groups dropped. Returns a VoxelItem or None (no mesh, or nothing hit)."""
    mesh = search._mesh(scan["model"])
    if mesh is None:
        return None
    cam = camera(scan, (mask.shape[1], mask.shape[0]))
    inner = shrink(mask, 2)
    pts = hit_points(mesh, cam, inner if inner.sum() > 200 else mask, step)
    pts = main_parts(pts[np.isfinite(pts[..., 0])])
    return VoxelItem.from_points(pts) if len(pts) >= 20 else None


def seen_share(model, item, n=500):
    """For every panorama, the share of the item's voxels it has a clear line of sight to
    (agent_edit.seen_share)."""
    s, mesh = search._scan(model), search._mesh(model)
    c = item.centres[np.random.default_rng(0).choice(len(item.centres), min(n, len(item.centres)), replace=False)]
    out = []
    for j in range(len(s)):
        v = c - s.position(j)
        dist = np.linalg.norm(v, axis=1)
        t = mesh.cast(s.position(j), v / dist[:, None])
        out.append(round(float((t >= dist - 0.12).mean()), 3))
    return out


def frame_on(model, pano, item, side, fill=0.5):
    """A square view from panorama `pano`, centred on the item, which spans `fill` of it."""
    cam, dist = frame(item, search._scan(model).position(pano), size=side, fill=fill)
    yaw, pitch = angles(cam)
    return {"model": model, "pano": int(pano), "yaw": round(yaw, 2), "pitch": round(pitch, 2),
            "fov": round(max(MIN_FOV, cam.fov), 2)}, round(dist, 2)


def mesh_mask(scan, item, size, step=2):
    """Pixels whose first mesh hit is an item voxel (full size), and the coarse on / clearly-off grids."""
    mesh = search._mesh(scan["model"])
    cam = camera(scan, size)
    region = np.asarray(item.mask(cam, dilate=12)) > 0
    pts = hit_points(mesh, cam, region, step)
    valid = np.isfinite(pts[..., 0])
    on, off = np.zeros(valid.shape, bool), np.zeros(valid.shape, bool)
    on[valid] = item.inside(pts[valid], margin=item.voxel)
    off[valid] = ~item.inside(pts[valid], margin=0.30)
    on = shrink(grow(on, 1), 1)
    full = np.asarray(Image.fromarray(on.astype(np.uint8) * 255).resize(size, Image.NEAREST)) > 0
    return full, on, off


def sam_mask(view, scan, item, run, tag="view", step=2):
    """The item's mask in a view: the mesh mask as SAM's box and points, and the SAM outline most
    like the mesh mask. Returns (mask or None, info)."""
    size = Image.open(view).size
    full, on, off = mesh_mask(scan, item, size, step)
    if full.sum() < 30:
        return None, {"mesh_px": int(full.sum())}
    ys, xs = np.nonzero(full)
    pad = 0.02 * max(size)
    box = [float(max(0, xs.min() - pad)), float(max(0, ys.min() - pad)),
           float(min(size[0], xs.max() + pad)), float(min(size[1], ys.max() + pad))]
    cell = lambda m: (np.argwhere(m)[:, ::-1] + 0.5) * step
    pos = shrink(on, 1) if shrink(on, 1).any() else on
    inside_box = np.zeros_like(on)
    inside_box[int(box[1] // step):int(box[3] // step) + 1, int(box[0] // step):int(box[2] // step) + 1] = True
    positive, negative = spread(cell(pos), 8), spread(cell(shrink(off, 3) & inside_box), 6)
    points = np.concatenate([positive, negative]) if len(negative) else positive
    found, info = sam(view, [{"name": tag, "box": box, "points": points.round(1).tolist(),
                              "labels": [1] * len(positive) + [0] * len(negative), "multimask": True}], run, tag=tag)
    best, best_iou = None, 0.0
    for cand in found[tag]:
        iou = float((cand["mask"] & full).sum() / max(1, (cand["mask"] | full).sum()))
        if iou > best_iou:
            best, best_iou = cand["mask"], iou
    Image.fromarray(full.astype(np.uint8) * 255).save(run / f"{tag}_mesh_mask.png")
    return best, {**info, "mesh_px": int(full.sum()), "iou_mesh": round(best_iou, 3)}


def correspond(scan_to, size, scan_from, mask_from, step=1):
    """Surface points seen through `mask_from` in one view that the other view also sees. Returns their
    pixels in the first view (k, 2) and in the other view (k, 2), as x, y."""
    mesh = search._mesh(scan_from["model"])
    cam_f, cam_t = camera(scan_from, size), camera(scan_to, size)
    pts = hit_points(mesh, cam_f, mask_from, step)
    ys, xs = np.nonzero(np.isfinite(pts[..., 0]))
    p = pts[ys, xs]
    x, y, z = cam_t.project(p)
    ok = (z > 0.05) & (x >= 0) & (x < size[0] - 1) & (y >= 0) & (y < size[1] - 1)
    d = p - cam_t.pos
    dist = np.linalg.norm(d, axis=1)
    t = np.full(len(p), np.inf)
    if ok.any():
        t[ok] = mesh.cast(cam_t.pos, d[ok] / dist[ok, None])
    ok &= np.abs(t - dist) < SEE_TOL
    here = np.stack([xs * step + step // 2, ys * step + step // 2], 1)[ok]
    return here, np.stack([x[ok], y[ok]], 1)


def sample(img, xy):
    """Bilinear samples of an (h, w, c) float array at (k, 2) x, y."""
    x, y = xy[:, 0] - 0.5, xy[:, 1] - 0.5
    x0, y0 = np.clip(np.floor(x).astype(int), 0, img.shape[1] - 2), np.clip(np.floor(y).astype(int), 0, img.shape[0] - 2)
    fx, fy = np.clip(x - x0, 0, 1)[:, None], np.clip(y - y0, 0, 1)[:, None]
    return ((img[y0, x0] * (1 - fx) + img[y0, x0 + 1] * fx) * (1 - fy)
            + (img[y0 + 1, x0] * (1 - fx) + img[y0 + 1, x0 + 1] * fx) * fy)


def guide(view, scan, mask, src_scan, src_edited, out_path):
    """This view with the item's pixels taken from another view's result, through the mesh. Pixels the
    other view cannot see stay as they are. Returns the path and the share of the mask that was filled."""
    img = np.asarray(Image.open(view).convert("RGB"), np.float32)
    src = np.asarray(Image.open(src_edited).convert("RGB"), np.float32)
    here, there = correspond(src_scan, (img.shape[1], img.shape[0]), scan, mask, step=1)
    out = img.copy()
    if len(here):
        out[here[:, 1], here[:, 0]] = sample(src, there)
    Image.fromarray(np.clip(out, 0, 255).astype(np.uint8)).save(out_path)
    return out_path, round(len(here) / max(1, int(mask.sum())), 3)


PATTERN_BAND = (2, 8)     # pixels; the photos' own correlation (the ceiling) is about 0.2 at (1, 4): the mesh is off by a few pixels
CHANGED = 12.0            # CIELAB distance from the photo above which a pixel counts as changed


def _band(lab_l, band):
    from edit_agent.metrics import smooth
    return smooth(lab_l, band[0]) - smooth(lab_l, band[1])


def agreement(scan_a, orig_a, edited_a, mask_a, scan_b, orig_b, edited_b, mask_b, band=PATTERN_BAND):
    """How alike the thing looks in two views, at the surface points both see.

    - changed_share: share of those points that either view changed.
    - same_parts: of the points either view changed, the share both changed. A recolour changes only
      part of the thing; 1 means both views recoloured the same parts.
    - change_gap: median CIELAB distance between the two views' changes (result minus photo), over the
      changed points. The photos' own differences (exposure, the angle of the light) cancel.
    - colour_gap / colour_gap_photo: the results' own CIELAB distance there, and the photos' for scale.
    - pattern / pattern_photo: correlation of light and dark detail (`band`) between the views over all
      the points, for the results and for the photos. The photos' value is the ceiling: how well the
      mesh lines the two views up.
    """
    size = Image.open(orig_b).size
    here, there = correspond(scan_a, size, scan_b, shrink(mask_b, 2), step=2)
    keep = shrink(mask_a, 2)[np.clip(there[:, 1].astype(int), 0, size[1] - 1), np.clip(there[:, 0].astype(int), 0, size[0] - 1)]
    here, there = here[keep], there[keep]
    if len(here) < 50:
        return {"points": int(len(here))}
    labs = {k: colour.to_lab(np.asarray(Image.open(p).convert("RGB"))) for k, p in
            (("oa", orig_a), ("ea", edited_a), ("ob", orig_b), ("eb", edited_b))}
    at_b = lambda k: labs[k][here[:, 1], here[:, 0]]
    at_a = lambda k: sample(labs[k], there)
    gap = lambda u, v: round(float(np.median(np.linalg.norm(u - v, axis=1))), 2)
    da, db = at_a("ea") - at_a("oa"), at_b("eb") - at_b("ob")
    ca, cb = np.linalg.norm(da, axis=1) > CHANGED, np.linalg.norm(db, axis=1) > CHANGED
    either = ca | cb
    out = {"points": int(len(here)), "changed_share": round(float(either.mean()), 3),
           "same_parts": round(float((ca & cb).sum() / max(1, either.sum())), 3)}
    if either.sum() >= 20:
        out.update(change_gap=gap(da[either], db[either]), colour_gap=gap(at_a("ea")[either], at_b("eb")[either]),
                   colour_gap_photo=gap(at_a("oa")[either], at_b("ob")[either]))
    for name, (ka, kb) in (("pattern", ("ea", "eb")), ("pattern_photo", ("oa", "ob"))):
        fa = sample(_band(labs[ka][..., 0], band)[..., None], there)[:, 0]
        fb = _band(labs[kb][..., 0], band)[here[:, 1], here[:, 0]]
        fa, fb = fa - fa.mean(), fb - fb.mean()
        den = float(np.sqrt((fa * fa).sum() * (fb * fb).sum()))
        out[name] = round(float((fa * fb).sum() / den), 3) if den else None
    return out

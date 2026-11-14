"""Lift a 2D selection into 3D with the scan's mesh, and find it again from other panoramas.

A selection (a mask in one view) becomes a set of 5 cm voxels: for every masked pixel, the point
where its ray first hits the mesh. From any other position, a pixel belongs to the item when the
first mesh surface along its ray lies in one of those voxels, so things standing in front of the
item are left out without asking a model.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np
from PIL import Image, ImageFilter

VOXEL = 0.05
_OFF = 1 << 20          # voxel indices are offset so they are positive, then packed into one int64


def voxel_keys(pts, voxel=VOXEL):
    ijk = np.floor(np.asarray(pts, float) / voxel).astype(np.int64) + _OFF
    return (ijk[..., 0] << 42) | (ijk[..., 1] << 21) | ijk[..., 2]


def key_centres(keys, voxel=VOXEL):
    ijk = np.stack([keys >> 42, (keys >> 21) & ((1 << 21) - 1), keys & ((1 << 21) - 1)], -1) - _OFF
    return (ijk + 0.5) * voxel


class VoxelItem:
    """An item as occupied voxels. Has the same inside / blocks / mask methods as build_case.Item."""

    def __init__(self, keys, voxel=VOXEL):
        self.voxel = voxel
        self.keys = np.unique(np.asarray(keys, np.int64))
        self.centres = key_centres(self.keys, voxel)
        self.lo, self.hi = self.centres.min(0) - voxel / 2, self.centres.max(0) + voxel / 2
        self.center = (self.lo + self.hi) / 2
        self._grown = {0: self.keys}

    @classmethod
    def from_points(cls, pts, voxel=VOXEL):
        return cls(voxel_keys(pts, voxel), voxel)

    @classmethod
    def load(cls, path):
        z = np.load(path)
        return cls(z["keys"], float(z["voxel"]))

    def save(self, path):
        np.savez_compressed(path, keys=self.keys, voxel=self.voxel)

    def _set(self, r):
        """Sorted keys of the voxels within r voxels (a cube) of the item."""
        if r not in self._grown:
            o = np.arange(-r, r + 1, dtype=np.int64)
            shift = ((o[:, None, None] << 42) + (o[None, :, None] << 21) + o[None, None, :]).ravel()
            self._grown[r] = np.unique((self.keys[:, None] + shift[None, :]).ravel())
        return self._grown[r]

    def inside(self, pts, margin=0.0):
        """True for points in an item voxel, or within `margin` metres of one (rounded up to whole voxels)."""
        pts = np.asarray(pts, float)
        s = self._set(int(np.ceil(margin / self.voxel - 1e-9)))
        k = voxel_keys(pts, self.voxel).ravel()
        i = np.minimum(np.searchsorted(s, k), len(s) - 1)
        return (s[i] == k).reshape(pts.shape[:-1])

    def blocks(self, origin, pts, samples=160):
        """True where the straight line from origin to each point passes through the item."""
        out = np.zeros(len(pts), bool)
        for i in range(0, len(pts), 4000):
            p = pts[i:i + 4000]
            s = np.linspace(0.0, 1.0, samples, endpoint=False)[None, :, None]
            seg = origin[None, None, :] + s * (p[:, None, :] - origin[None, None, :])
            out[i:i + 4000] = self.inside(seg, margin=self.voxel).any(1)
        return out

    def mask(self, cam, dilate=0):
        """The voxels drawn into a view (ignores anything in front of them). Used for framing."""
        x, y, z = cam.project(self.centres)
        ok = (z > 0.05) & (x >= 0) & (x < cam.w) & (y >= 0) & (y < cam.h)
        img = np.zeros((cam.h, cam.w), np.uint8)
        img[y[ok].astype(int), x[ok].astype(int)] = 255
        if ok.any():
            r = int(np.clip(np.ceil(0.75 * self.voxel * cam.focal / np.median(z[ok])), 1, 30)) + dilate
        else:
            r = dilate
        out = Image.fromarray(img)
        while r > 0:                                # large MaxFilter kernels are slow: grow in steps
            k = min(r, 15)
            out = out.filter(ImageFilter.MaxFilter(2 * k + 1))
            r -= k
        return out


def hit_points(mesh, cam, region, step=4):
    """First mesh hit along the rays through `region` (bool, crop size), one ray per `step` pixels.

    Returns an (h/step, w/step, 3) array of world points, NaN where no ray was cast or nothing was hit.
    """
    rays = cam.rays(step)
    sel = region[step // 2::step, step // 2::step]
    ys, xs = np.nonzero(sel)
    out = np.full(rays.shape, np.nan)
    if len(xs):
        d = rays[ys, xs]
        t = mesh.cast(cam.pos, d)
        ok = np.isfinite(t) & (t < 15.0)
        out[ys[ok], xs[ok]] = cam.pos + d[ok] * t[ok, None]
    return out


def coarse(mask, step=4, erode=0):
    """A full-size bool mask sampled at the ray grid, optionally eroded by `erode` pixels first."""
    if erode:
        mask = np.asarray(Image.fromarray(mask.astype(np.uint8) * 255).filter(ImageFilter.MinFilter(2 * erode + 1))) > 0
    return mask[step // 2::step, step // 2::step]


def main_parts(pts, voxel=VOXEL, keep=0.03):
    """Drop stray points: keep those in connected groups of voxels that hold at least `keep` of all points.

    Rays that slip past the item's edge, or through a hole in the mesh, land far behind it; those
    form small separate groups.
    """
    if len(pts) == 0:
        return pts
    ijk = np.floor(pts / voxel).astype(np.int64)
    cells, inverse, counts = np.unique(ijk, axis=0, return_inverse=True, return_counts=True)
    inverse = inverse.ravel()
    index = {tuple(c): i for i, c in enumerate(cells)}
    group = np.full(len(cells), -1)
    near = [(a, b, c) for a in (-1, 0, 1) for b in (-1, 0, 1) for c in (-1, 0, 1) if (a, b, c) != (0, 0, 0)]
    n = 0
    for start in range(len(cells)):
        if group[start] >= 0:
            continue
        group[start] = n
        stack = [start]
        while stack:
            i = stack.pop()
            a, b, c = cells[i]
            for da, db, dc in near:
                j = index.get((a + da, b + db, c + dc))
                if j is not None and group[j] < 0:
                    group[j] = n
                    stack.append(j)
        n += 1
    size = np.bincount(group, weights=counts, minlength=n)
    good = size >= keep * len(pts)
    return pts[good[group[inverse]]]


def spread(points, n):
    """Up to n of the given (k, 2) points, chosen far apart (greedy farthest-point sampling)."""
    points = np.asarray(points, float)
    if len(points) <= n:
        return points
    chosen = [int(np.argmin(((points - points.mean(0)) ** 2).sum(1)))]
    dist = ((points - points[chosen[0]]) ** 2).sum(1)
    while len(chosen) < n:
        chosen.append(int(np.argmax(dist)))
        dist = np.minimum(dist, ((points - points[chosen[-1]]) ** 2).sum(1))
    return points[chosen]


def grow(mask, px):
    out = Image.fromarray(mask.astype(np.uint8) * 255)
    while px > 0:
        k = min(px, 15)
        out = out.filter(ImageFilter.MaxFilter(2 * k + 1))
        px -= k
    return np.asarray(out) > 0


def shrink(mask, px):
    return ~grow(~mask, px)


def reproject(mask, src_cam, dst_cam):
    """A mask drawn in one view, redrawn in another view from the same position (exact: no parallax)."""
    d = dst_cam.rays()
    x, y, z = src_cam.project(src_cam.pos + d)
    ok = (z > 0) & (x >= 0) & (x < src_cam.w) & (y >= 0) & (y < src_cam.h)
    out = np.zeros((dst_cam.h, dst_cam.w), bool)
    out[ok] = mask[y[ok].astype(int), x[ok].astype(int)]
    return out

"""Perspective views from downloaded cube-face panoramas, and a small ray caster for the mesh.

Uses the conventions measured for this dataset (see the manifest's `conventions` block):
world is right-handed, Z up, meters; the pano quaternion rotates pano-local into world;
faces are 0 up, 1 +X, 2 -Y, 3 -X, 4 +Y, 5 down, with image-right = forward x image-up.
"""
import json
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data"

_X, _Y, _Z = np.eye(3)
FACE_F = np.array([_Z, _X, -_Y, -_X, _Y, -_Z])          # forward
FACE_U = np.array([-_X, _Z, _Z, _Z, _Z, _X])            # image up
FACE_R = np.cross(FACE_F, FACE_U)                        # image right


def quat_to_matrix(q):
    x, y, z, w = q
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ])


class Camera:
    """Pinhole camera in the world frame. `fov` is the horizontal field of view in degrees."""

    def __init__(self, pos, forward, fov, width, height):
        self.pos = np.asarray(pos, float)
        f = np.asarray(forward, float)
        self.f = f / np.linalg.norm(f)
        r = np.cross(self.f, _Z)
        self.r = r / np.linalg.norm(r)
        self.u = np.cross(self.r, self.f)
        self.w, self.h = int(width), int(height)
        self.fov = float(fov)
        self.focal = (self.w / 2) / np.tan(np.radians(fov) / 2)

    @classmethod
    def looking_at(cls, pos, target, fov, width, height):
        return cls(pos, np.asarray(target, float) - np.asarray(pos, float), fov, width, height)

    @classmethod
    def from_angles(cls, pos, yaw, pitch, fov, width, height):
        y, p = np.radians(yaw), np.radians(pitch)
        return cls(pos, [np.cos(y) * np.cos(p), np.sin(y) * np.cos(p), np.sin(p)], fov, width, height)

    def rays(self, step=1):
        """Unit world directions for pixel centres, shape (h/step, w/step, 3)."""
        xs = (np.arange(0, self.w, step) + step / 2 - self.w / 2) / self.focal
        ys = (np.arange(0, self.h, step) + step / 2 - self.h / 2) / self.focal
        gx, gy = np.meshgrid(xs, ys)
        d = self.f + gx[..., None] * self.r - gy[..., None] * self.u
        return d / np.linalg.norm(d, axis=-1, keepdims=True)

    def project(self, points):
        """World points (..., 3) -> pixel x, y and depth along the view axis."""
        v = np.asarray(points, float) - self.pos
        z = v @ self.f
        zs = np.where(np.abs(z) < 1e-9, 1e-9, z)
        x = (v @ self.r) / zs * self.focal + self.w / 2
        y = -(v @ self.u) / zs * self.focal + self.h / 2
        return x, y, z


class Scan:
    def __init__(self, model_id):
        self.id = model_id
        self.dir = DATA / model_id
        self.manifest = json.loads((self.dir / "manifest.json").read_text(encoding="utf-8"))
        self.locations = self.manifest["locations"]
        self._faces = {}

    def __len__(self):
        return len(self.locations)

    def position(self, i):
        return np.array(self.locations[i]["position"], float)

    def rotation(self, i):
        """3x3 matrix taking pano-local directions to world."""
        return quat_to_matrix(self.locations[i]["rotation"])

    def faces(self, i):
        if i not in self._faces:
            if len(self._faces) >= 3:                      # ~75 MB per panorama
                self._faces.pop(next(iter(self._faces)))
            paths = [self.dir / p for p in self.locations[i]["faces"]]
            self._faces[i] = [np.asarray(Image.open(p).convert("RGB"), dtype=np.float32) for p in paths]
        return self._faces[i]

    def sample(self, i, dirs):
        """Colour seen from panorama i along world directions (..., 3). Bilinear, float32 0-255."""
        faces = self.faces(i)
        shape = dirs.shape[:-1]
        local = dirs.reshape(-1, 3) @ self.rotation(i)      # row vectors: R^T d
        k = np.argmax(local @ FACE_F.T, axis=1)
        out = np.zeros((local.shape[0], 3), np.float32)
        for face in range(6):
            sel = np.nonzero(k == face)[0]
            if sel.size == 0:
                continue
            d = local[sel]
            depth = d @ FACE_F[face]
            img = faces[face]
            h, w = img.shape[:2]
            px = np.clip(((d @ FACE_R[face]) / depth + 1) / 2 * w - 0.5, 0, w - 1)
            py = np.clip((1 - (d @ FACE_U[face]) / depth) / 2 * h - 0.5, 0, h - 1)
            x0 = np.minimum(px.astype(int), w - 2)
            y0 = np.minimum(py.astype(int), h - 2)
            fx, fy = (px - x0)[:, None], (py - y0)[:, None]
            out[sel] = ((img[y0, x0] * (1 - fx) + img[y0, x0 + 1] * fx) * (1 - fy)
                        + (img[y0 + 1, x0] * (1 - fx) + img[y0 + 1, x0 + 1] * fx) * fy)
        return out.reshape(*shape, 3)

    def view(self, i, camera):
        return Image.fromarray(np.clip(self.sample(i, camera.rays()), 0, 255).astype(np.uint8))

    def mesh(self):
        return Mesh(self.dir / self.manifest["mesh"]["path"])


class Mesh:
    """Triangles of the scan mesh with a brute-force (numpy) ray caster. Fine for thousands of rays."""

    def __init__(self, obj_path):
        cache = Path(__file__).resolve().parent / "cases" / "_cache" / (Path(obj_path).stem + ".npz")
        if cache.exists():
            z = np.load(cache)
            self.v, self.t = z["v"], z["t"]
        else:
            verts, tris = [], []
            with open(obj_path, encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    if line.startswith("v "):
                        verts.append(line.split()[1:4])
                    elif line.startswith("f "):
                        idx = [int(tok.split("/")[0]) - 1 for tok in line.split()[1:]]
                        tris.extend([idx[0], idx[j], idx[j + 1]] for j in range(1, len(idx) - 1))
            self.v, self.t = np.array(verts, np.float64), np.array(tris, np.int32)
            cache.parent.mkdir(parents=True, exist_ok=True)
            np.savez(cache, v=self.v, t=self.t)
        self.a = self.v[self.t[:, 0]]
        self.e1 = self.v[self.t[:, 1]] - self.a
        self.e2 = self.v[self.t[:, 2]] - self.a
        self.normal = np.cross(self.e1, self.e2)
        self.normal /= np.maximum(np.linalg.norm(self.normal, axis=1, keepdims=True), 1e-12)
        self.centroid = self.a + (self.e1 + self.e2) / 3

    def _hits(self, origin, dirs, sel):
        """Ray parameter t for rays (R, 3) against triangles `sel`, shape (R, K); inf where missed."""
        a, e1, e2 = self.a[sel], self.e1[sel], self.e2[sel]
        p = np.cross(dirs[:, None, :], e2[None])                 # (R, K, 3)
        det = np.einsum("kj,rkj->rk", e1, p)
        ok = np.abs(det) > 1e-10
        inv = np.where(ok, 1.0 / np.where(ok, det, 1.0), 0.0)
        s = origin - a                                           # (K, 3)
        u = np.einsum("kj,rkj->rk", s, p) * inv
        q = np.cross(s, e1)                                      # (K, 3)
        v = np.einsum("rj,kj->rk", dirs, q) * inv
        t = (e2 * q).sum(1)[None] * inv
        hit = ok & (u >= 0) & (v >= 0) & (u + v <= 1) & (t > 1e-4)
        return np.where(hit, t, np.inf)

    def _cone(self, origin, dirs, margin_deg=3.0):
        """Indices of triangles that can be hit by this bundle of rays (cone cull on centroids)."""
        axis = dirs.mean(0)
        axis /= np.linalg.norm(axis)
        half = np.arccos(np.clip(dirs @ axis, -1, 1)).max() + np.radians(margin_deg)
        c = self.centroid - origin
        dist = np.linalg.norm(c, axis=1)
        ang = np.arccos(np.clip((c @ axis) / np.maximum(dist, 1e-9), -1, 1))
        return np.nonzero((ang <= half + 0.15 / np.maximum(dist, 0.15)) | (dist < 0.3))[0]

    def cast(self, origin, dirs, skip=None, budget=4_000_000):
        """Distance to the nearest hit along each ray (inf if none). dirs: (..., 3) unit vectors.

        `skip` is an optional boolean array over triangles to ignore (e.g. the item being removed).
        """
        origin = np.asarray(origin, float)
        shape = dirs.shape[:-1]
        d = dirs.reshape(-1, 3).astype(float)
        out = np.full(d.shape[0], np.inf)
        if d.shape[0] == 0:
            return out.reshape(shape)
        sel = self._cone(origin, d)
        if skip is not None:
            sel = sel[~skip[sel]]
        if sel.size:
            chunk = max(1, budget // sel.size)
            for i in range(0, d.shape[0], chunk):
                out[i:i + chunk] = self._hits(origin, d[i:i + chunk], sel).min(1)
        return out.reshape(shape)

    def all_hits(self, origin, direction):
        """Sorted (t, triangle index) for every crossing of one ray."""
        d = np.asarray(direction, float)[None]
        d = d / np.linalg.norm(d)
        sel = self._cone(np.asarray(origin, float), d, margin_deg=5.0)
        t = self._hits(np.asarray(origin, float), d, sel)[0]
        order = np.argsort(t)
        order = order[np.isfinite(t[order])]
        return [(float(t[j]), int(sel[j])) for j in order]

    def visible(self, origin, point, tol=0.08):
        """True if `point` is seen from `origin` (no surface more than `tol` m in front of it)."""
        v = np.asarray(point, float) - np.asarray(origin, float)
        dist = np.linalg.norm(v)
        return bool(self.cast(origin, (v / dist)[None])[0] >= dist - tol)


def draw_grid(img, step=128):
    """Copy of `img` with a labelled pixel grid, to read coordinates off by eye."""
    from PIL import ImageDraw
    out = img.copy()
    d = ImageDraw.Draw(out)
    for x in range(0, out.width, step):
        d.line([(x, 0), (x, out.height)], fill=(255, 0, 255), width=1)
        d.text((x + 3, 2), str(x), fill=(255, 255, 0))
    for y in range(0, out.height, step):
        d.line([(0, y), (out.width, y)], fill=(255, 0, 255), width=1)
        d.text((2, y + 2), str(y), fill=(255, 255, 0))
    return out

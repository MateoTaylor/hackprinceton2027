"""A place to a downloaded scan: resolve ids, describe a scan, download it on demand.

Only geometry and pictures leave this module. CoStar records are read for two id columns and
nothing else, and none of their fields go into a response.
"""
from __future__ import annotations

import csv
import json
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from config import DATA, FETCH_TIMEOUT_S, FETCHER, KIT, OUT, RESOLUTION, ROOT, SAFE_ID


class ApiError(Exception):
    """An error with a stable code for the client. `message` never holds a path or a secret."""

    def __init__(self, status: int, code: str, message: str, **extra):
        super().__init__(message)
        self.status, self.code, self.message, self.extra = status, code, message, extra

    def body(self) -> dict:
        return {"error": {"code": self.code, "message": self.message, **self.extra}}


def check_id(value: str, what: str) -> str:
    if not isinstance(value, str) or not SAFE_ID.match(value):
        raise ApiError(400, "bad_request", f"{what} must match ^[A-Za-z0-9_-]+$")
    return value


# ---------------------------------------------------------------- the frame, stated once

_X, _Y, _Z = np.eye(3)
FACE_BASIS = {  # pano-local; image right = forward x up (pano.py FACE_F / FACE_U / FACE_R)
    str(n): {"forward": f.tolist(), "up": u.tolist(), "right": np.cross(f, u).tolist()}
    for n, (f, u) in enumerate(zip([_Z, _X, -_Y, -_X, _Y, -_Z], [-_X, _Z, _Z, _Z, _Z, _X]))
}
FRAME = {
    "world": "right-handed, Z up, metres; the frame of the MatterPak OBJ",
    "rotation": "quaternion [x, y, z, w]; rotates pano-local directions into world, used as given",
    "faces": "0 up (+Z), 1 +X, 2 -Y, 3 -X, 4 +Y, 5 down (-Z), in the panorama's own frame",
    "face_basis": FACE_BASIS,
    "face_pixel": "pixel (i, j) of a face of size s looks along forward + a*right + b*up, "
                  "a = (i + 0.5) / s * 2 - 1, b = 1 - (j + 0.5) / s * 2 (i is the column, j the row)",
    "yaw_pitch": "yaw = atan2(forward.y, forward.x) in degrees, from +X towards +Y; "
                 "pitch = degrees up from level; both in the world frame",
}


# ---------------------------------------------------------------- reading scans on disk

def manifest_path(model_id: str) -> Path:
    return DATA / check_id(model_id, "model_id") / "manifest.json"


def manifest(model_id: str) -> dict | None:
    p = manifest_path(model_id)
    return json.loads(p.read_text(encoding="utf-8")) if p.is_file() else None


def has_mesh(m: dict, model_id: str) -> bool:
    mesh = m.get("mesh")
    return bool(mesh and (DATA / model_id / mesh["path"]).is_file())


def face_url(model_id: str, pano_id: str, n: int) -> str:
    return f"/places/{model_id}/panos/{pano_id}/faces/{n}"


def pano_index(m: dict, pano_id: str) -> int:
    """A panorama's index in locations[], from its `id` (or its `location_id`, the sweep id)."""
    check_id(pano_id, "pano_id")
    for i, loc in enumerate(m["locations"]):
        if loc["id"] == pano_id:
            return i
    for i, loc in enumerate(m["locations"]):
        if loc.get("location_id") == pano_id:
            return i
    raise ApiError(404, "unknown_pano", "no panorama with that id in this scan")


def face_file(model_id: str, pano_id: str, n: int) -> Path:
    """The original face on disk, looked up through the manifest. Nothing from the request is
    joined into the path except through that lookup."""
    m = manifest(model_id)
    if m is None:
        raise ApiError(404, "unknown_place", "that scan is not downloaded on this PC")
    if not 0 <= n <= 5:
        raise ApiError(404, "not_found", "faces are numbered 0 to 5")
    loc = m["locations"][pano_index(m, pano_id)]
    base = (DATA / model_id).resolve()
    rel = loc["faces"][n]
    if not rel:
        raise ApiError(404, "not_found", "that face was not downloaded")
    path = (base / rel).resolve()
    if not path.is_relative_to(base) or any(part.startswith(".") for part in Path(rel).parts) or not path.is_file():
        raise ApiError(404, "not_found", "that face is not available")
    return path


def pano_entry(model_id: str, i: int, loc: dict) -> dict:
    return {
        "id": loc["id"], "location_id": loc.get("location_id"), "index": i,
        "label": loc.get("label"), "floor": loc.get("floor"),
        "position": loc["position"], "rotation": loc["rotation"],
        "faces": [face_url(model_id, loc["id"], n) for n in range(6)],
    }


def summary(model_id: str) -> dict:
    """What GET /places/{model_id} answers. Does not call Matterport."""
    m = manifest(model_id)
    if m is None:
        return {"model_id": model_id, "downloaded": False, "has_mesh": None, "panos": []}
    face_size = None
    if m["locations"]:
        try:
            from PIL import Image
            with Image.open(face_file(model_id, m["locations"][0]["id"], 1)) as im:
                face_size = im.size[0]
        except ApiError:
            pass
    return {
        "model_id": model_id, "downloaded": True, "has_mesh": has_mesh(m, model_id),
        "resolution": m.get("resolution"), "face_size": face_size, "frame": FRAME,
        "panos": [pano_entry(model_id, i, loc) for i, loc in enumerate(m["locations"])],
    }


def listing() -> list[dict]:
    p = DATA / "index.json"
    models = json.loads(p.read_text(encoding="utf-8")).get("models", []) if p.is_file() else []
    out = []
    for entry in models:
        mid = entry.get("id", "")
        m = manifest(mid) if SAFE_ID.match(mid) else None
        if m:
            out.append({"model_id": mid, "panos": len(m["locations"]), "has_mesh": has_mesh(m, mid)})
    return out


# ---------------------------------------------------------------- a property to its models

def models_for_property(property_id: str) -> list[str]:
    """Matterport model ids for a CoStar property or residential listing. Reads two columns."""
    check_id(property_id, "property_id")
    tables = [(KIT / "commercial-properties.csv", "PropertyId"),
              (KIT / "residential-listings.csv", "ResidentialListingId")]
    if not any(path.is_file() for path, _ in tables):
        raise ApiError(501, "property_lookup_unavailable",
                       "the CoStar kit is not on this PC; send place.model_id instead")
    found: list[str] = []
    for path, key in tables:
        if not path.is_file():
            continue
        with open(path, encoding="utf-8-sig", newline="") as fh:
            for row in csv.DictReader(fh):
                if (row.get(key) or "").strip() == property_id:
                    mid = (row.get("MatterportModelId") or "").strip()
                    if SAFE_ID.match(mid) and mid not in found:
                        found.append(mid)
    return found


def resolve(place: dict) -> str:
    """One model id for a place, or an ApiError (unknown, or several to choose from)."""
    if place.get("model_id"):
        return check_id(place["model_id"], "place.model_id")
    models = models_for_property(place["property_id"])
    if not models:
        raise ApiError(404, "unknown_place", "no Matterport scan is listed for that property")
    if len(models) > 1:
        raise ApiError(409, "several_models", "that property has several scans; send one as place.model_id",
                       candidates=[{"model_id": mid, "downloaded": manifest(mid) is not None} for mid in models])
    return models[0]


# ---------------------------------------------------------------- downloading on demand

MESH_CHECKS = OUT / "mesh_checks.json"


def _mesh_checks() -> dict:
    return json.loads(MESH_CHECKS.read_text(encoding="utf-8")) if MESH_CHECKS.is_file() else {}


def fetch_panos(model_id: str, log: Path) -> None:
    """`fetch_matterport.py fetch <id> --resolution 2k`, run as it is. Output goes to `log` only."""
    check_id(model_id, "model_id")
    log.parent.mkdir(parents=True, exist_ok=True)
    with open(log, "a", encoding="utf-8") as out:
        out.write(f"\n## fetch {model_id} {datetime.now(timezone.utc).isoformat(timespec='seconds')}\n")
        out.flush()
        try:
            proc = subprocess.run([sys.executable, str(FETCHER), "fetch", model_id, "--resolution", RESOLUTION],
                                  cwd=ROOT, stdout=out, stderr=subprocess.STDOUT, timeout=FETCH_TIMEOUT_S)
        except subprocess.TimeoutExpired:
            raise ApiError(502, "download_failed", "the download took too long") from None
    if proc.returncode != 0 or manifest(model_id) is None:
        text = log.read_text(encoding="utf-8", errors="replace")
        tail = text[text.rfind(f"## fetch {model_id}"):]
        if "No model returned" in tail or "not.found" in tail or "Not Found" in tail:
            raise ApiError(404, "unknown_place", "Matterport has no scan with that id that this account can read")
        raise ApiError(502, "download_failed", "the panorama download failed")


def fetch_mesh(model_id: str, log: Path) -> bool:
    """Download an already-unlocked MatterPak, once per model. Never unlocks anything: it reads the
    bundle list and downloads only assets that already carry a URL, from MatterPak bundles only."""
    checks = _mesh_checks()
    if model_id in checks:
        return checks[model_id]["found"]
    sys.path.insert(0, str(FETCHER.parent))
    import fetch_matterport as fm
    fm.load_env_file(ROOT / ".env")
    found = False
    with open(log, "a", encoding="utf-8") as out:
        out.write(f"\n## mesh {model_id}\n")
        try:
            data = fm.gql(fm.BUNDLES_QUERY.replace("%MODEL%", model_id))
            model_dir = DATA / model_id
            for bundle in (data.get("model") or {}).get("bundles") or []:
                if "matterpak" not in (bundle.get("id") or "").lower():
                    continue
                for asset in bundle.get("assets") or []:
                    if not asset.get("url"):
                        out.write(f"{bundle['id']}: locked or no url, skipped\n")
                        continue
                    name = fm.safe_name(asset.get("filename") or "matterpak.zip")
                    dest = model_dir / "bundles" / fm.safe_name(bundle["id"]) / name
                    out.write(f"{bundle['id']}: downloading {name}\n")
                    fm.download(asset["url"], dest)
                    if dest.suffix.lower() == ".zip":
                        fm.safe_extract(dest, dest.with_suffix(""))
            fm.update_manifest_mesh(model_dir)
            m = manifest(model_id)
            found = bool(m and has_mesh(m, model_id))
        except Exception as err:  # a mesh is optional: report it in the log, carry on without
            out.write(f"mesh check failed: {type(err).__name__}\n")
            return False
    checks[model_id] = {"found": found, "checked_at": time.strftime("%Y-%m-%dT%H:%M:%S")}
    MESH_CHECKS.parent.mkdir(parents=True, exist_ok=True)
    MESH_CHECKS.write_text(json.dumps(checks, indent=1), encoding="utf-8")
    return found


def ensure(model_id: str, log: Path, emit) -> dict:
    """The scan on disk, downloading what is missing. Returns its manifest."""
    m = manifest(model_id)
    if m is None:
        emit({"step": "fetch_panos", "status": "started"})
        t = time.time()
        fetch_panos(model_id, log)
        emit({"step": "fetch_panos", "status": "done", "seconds": round(time.time() - t, 1)})
        m = manifest(model_id)
    if not has_mesh(m, model_id) and model_id not in _mesh_checks():
        emit({"step": "fetch_mesh", "status": "started"})
        t = time.time()
        found = fetch_mesh(model_id, log)
        emit({"step": "fetch_mesh", "status": "done", "seconds": round(time.time() - t, 1), "found": found})
        m = manifest(model_id)
    return m

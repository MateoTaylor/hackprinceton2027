#!/usr/bin/env python3
"""Download one Matterport model's panoramas (and its mesh, if already unlocked) for local testing.

Standard library only, so it runs on a bare Python install.

Credentials: set MP_TOKEN_ID and MP_TOKEN_SECRET (my.matterport.com > Settings > Developer Tools),
either in the environment or in a .env file in the project root. A Sandbox account only sees
Matterport's demo model; use the `demo` command to find its id.

Examples:
  py tools/fetch_matterport.py list --query 1BR              # models this account can read
  py tools/fetch_matterport.py demo                          # list the demo model id(s)
  py tools/fetch_matterport.py fetch <model_id>              # panoramas + data/<id>/manifest.json
  py tools/fetch_matterport.py fetch <model_id> --resolution high --limit 5
  py tools/fetch_matterport.py bundles <model_id>            # MatterPak / E57 / floor plan status
  py tools/fetch_matterport.py bundles <model_id> --download # download assets that are already unlocked
  py tools/fetch_matterport.py add-mesh <model_id> path\\to\\matterpak.zip   # mesh from the hackathon kit
  py tools/fetch_matterport.py introspect PanoramicImageLocation           # print a schema type

This script never buys anything: it does not call unlockModelBundle (MatterPak and E57 are paid add-ons).
The API's coordinate conventions are undocumented, so positions and rotations are stored raw; the viewer
(viewer/index.html) is where you find the right axis, rotation and cube-face settings.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
API_URL = os.environ.get("MP_API_URL", "https://api.matterport.com/api/models/graph")
RESOLUTIONS = ("low", "high", "2k", "4k")  # 512, 1024, 2048, 4096 px per cube face; 4k needs a paid pack
USER_AGENT = "matterport-fetch/0.1"
SAFE_ID = re.compile(r"^[A-Za-z0-9_-]+$")


# Measured on model zzvymDx5ty7 with viewer/index.html (seam matching + mesh correlation, all 9 panos).
CONVENTIONS = {
    "world": "right-handed, Z up, meters; same frame as the MatterPak OBJ and cloud.xyz",
    "rotation": "quaternion [x, y, z, w] rotates pano-local directions into world (use as-is)",
    "pano_local": "Z up; face 1 looks along local +X",
    "faces": {
        "0": "up (+Z); image top points along local -X (rotated 180 deg)",
        "1": "+X", "2": "-Y", "3": "-X", "4": "+Y",
        "5": "down (-Z); image top points along local +X",
    },
    "side_faces": "image up = +Z, image right = forward x up",
}


class GraphQLError(RuntimeError):
    def __init__(self, message: str, data: dict | None = None):
        super().__init__(message)
        self.data = data


# ---------------------------------------------------------------- credentials and HTTP

def load_env_file(path: Path) -> None:
    """Read KEY=VALUE lines from .env without overriding variables already set."""
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def auth_header() -> str:
    token_id = os.environ.get("MP_TOKEN_ID")
    secret = os.environ.get("MP_TOKEN_SECRET")
    if not token_id or not secret:
        sys.exit("Missing credentials: set MP_TOKEN_ID and MP_TOKEN_SECRET in the environment "
                 "or in a .env file in the project root.")
    return "Basic " + base64.b64encode(f"{token_id}:{secret}".encode()).decode()


def gql(query: str, variables: dict | None = None) -> dict:
    body = json.dumps({"query": query, "variables": variables or {}}).encode()
    request = urllib.request.Request(API_URL, data=body, method="POST", headers={
        "Content-Type": "application/json",
        "Authorization": auth_header(),
        "User-Agent": USER_AGENT,
    })
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            payload = json.load(response)
    except urllib.error.HTTPError as err:
        detail = err.read().decode(errors="replace")[:800]
        raise GraphQLError(f"HTTP {err.code} from {API_URL}: {detail}") from None
    if payload.get("errors"):
        messages = "; ".join(e.get("message", str(e)) for e in payload["errors"])
        raise GraphQLError(messages, payload.get("data"))
    return payload["data"]


def download(url: str, dest: Path, retries: int = 3) -> bool:
    """Download url to dest unless it already exists. Signed CDN URLs need no auth header."""
    if dest.exists() and dest.stat().st_size > 0:
        return False
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(dest.name + ".part")
    for attempt in range(1, retries + 1):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(request, timeout=180) as response, open(tmp, "wb") as out:
                while chunk := response.read(1 << 20):
                    out.write(chunk)
            tmp.replace(dest)
            return True
        except urllib.error.HTTPError as err:
            if err.code in (401, 403):
                raise RuntimeError(f"HTTP {err.code} for {dest.name}: the signed URL has probably "
                                   "expired. Re-run the command; finished files are skipped.") from None
            if attempt == retries:
                raise
        except (urllib.error.URLError, TimeoutError):
            if attempt == retries:
                raise
        time.sleep(2 * attempt)
    return False


def check_id(model_id: str) -> str:
    if not SAFE_ID.match(model_id):
        sys.exit(f"Model id {model_id!r} has unexpected characters.")
    return model_id


def safe_name(text: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]", "_", text)[:120] or "unnamed"


def url_ext(url: str, default: str = ".jpg") -> str:
    """File extension from a signed URL's path (the API's `format` field just says "skybox")."""
    suffix = Path(urllib.parse.urlsplit(url).path).suffix.lower()
    return suffix if suffix in (".jpg", ".jpeg", ".png", ".webp") else default


# ---------------------------------------------------------------- mesh discovery and manifest

def safe_extract(zip_path: Path, dest: Path) -> None:
    """Extract a zip, refusing entries that would land outside dest."""
    dest = dest.resolve()
    with zipfile.ZipFile(zip_path) as archive:
        for member in archive.infolist():
            target = (dest / member.filename).resolve()
            if not target.is_relative_to(dest):
                raise RuntimeError(f"Refusing unsafe path in zip: {member.filename}")
        archive.extractall(dest)


def find_meshes(model_dir: Path) -> list[dict]:
    """List every glb/gltf/obj under the model folder, textured and largest first."""
    rel = lambda p: p.relative_to(model_dir).as_posix()
    entries = []
    for path in sorted(model_dir.rglob("*")):
        suffix = path.suffix.lower()
        if suffix not in (".glb", ".gltf", ".obj"):
            continue
        entry = {"type": "obj" if suffix == ".obj" else "gltf", "path": rel(path),
                 "bytes": path.stat().st_size, "mtl": None}
        if suffix == ".obj":
            with open(path, encoding="utf-8", errors="replace") as f:
                for _, line in zip(range(200), f):
                    if line.startswith("mtllib "):
                        candidate = path.parent / line.split(maxsplit=1)[1].strip()
                        if candidate.is_file():
                            entry["mtl"] = rel(candidate)
                        break
        entries.append(entry)
    entries.sort(key=lambda e: (e["type"] == "gltf" or e["mtl"] is not None, e["bytes"]), reverse=True)
    return entries


def update_manifest_mesh(model_dir: Path) -> None:
    manifest_path = model_dir / "manifest.json"
    if not manifest_path.is_file():
        return
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["meshes"] = find_meshes(model_dir)
    manifest["mesh"] = manifest["meshes"][0] if manifest["meshes"] else None
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    for entry in manifest["meshes"]:
        print(f"mesh: {entry['path']}  ({entry['bytes'] / 1e6:.1f} MB, mtl={entry['mtl']})")


def update_index(model_id: str, name: str | None, panos: int) -> None:
    """Keep data/index.json listing downloaded models, for the viewer's model picker."""
    index_path = DATA / "index.json"
    index = json.loads(index_path.read_text(encoding="utf-8")) if index_path.is_file() else {"models": []}
    index["models"] = [m for m in index["models"] if m["id"] != model_id]
    index["models"].append({"id": model_id, "name": name, "panos": panos})
    index_path.write_text(json.dumps(index, indent=2), encoding="utf-8")


# ---------------------------------------------------------------- commands

LOCATIONS_QUERY = """
{
  model(id: "%MODEL%") {
    id
    name
    locations {
      id
      label
      position { x y z }
      floor { id label }
      room { id }
      panos {
        id
        position { x y z }
        rotation { x y z w }
        skybox(resolution: "%RES%") { id status format url urlTemplate validUntil children }
      }
    }
  }
}
"""


def face_urls(skybox: dict) -> list[str | None]:
    """Return six face URLs indexed 0-5, using the _skyboxN suffix when present."""
    faces: list[str | None] = [None] * 6
    children = [c for c in (skybox.get("children") or []) if c]
    for order, url in enumerate(children[:6]):
        match = re.search(r"skybox(\d)", url)
        index = int(match.group(1)) if match and int(match.group(1)) < 6 else order
        faces[index] = url
    template = skybox.get("urlTemplate")
    if not any(faces) and template:
        placeholder = re.search(r"<[^>]+>|\{[^}]+\}", template)
        if placeholder:
            faces = [template.replace(placeholder.group(0), str(i)) for i in range(6)]
    return faces


def cmd_fetch(args: argparse.Namespace) -> None:
    model_id = check_id(args.model_id)
    query = LOCATIONS_QUERY.replace("%MODEL%", model_id).replace("%RES%", args.resolution)
    data = gql(query)
    model = data.get("model")
    if not model:
        sys.exit("No model returned. Check the id, and note a Sandbox account only sees the demo model.")
    model_dir = DATA / model_id
    model_dir.mkdir(parents=True, exist_ok=True)
    (model_dir / "raw_locations.json").write_text(json.dumps(data, indent=2), encoding="utf-8")

    entries = []
    for location in model.get("locations") or []:
        for pano in location.get("panos") or []:
            entries.append((location, pano))
    print(f"{model.get('name')!r}: {len(entries)} panoramas")
    if args.limit:
        entries = entries[: args.limit]

    locations_out = []
    for n, (location, pano) in enumerate(entries, 1):
        skybox = pano.get("skybox") or {}
        if skybox.get("status") not in (None, "available"):
            print(f"  [{n}] pano {pano['id']}: skybox status {skybox.get('status')}, skipped")
            continue
        pano_dir = model_dir / "panos" / safe_name(pano["id"])
        faces = []
        for index, url in enumerate(face_urls(skybox)):
            if not url:
                faces.append(None)
                continue
            dest = pano_dir / f"{index}{url_ext(url)}"
            download(url, dest)
            faces.append(dest.relative_to(model_dir).as_posix())
        position = pano.get("position") or location.get("position") or {}
        rotation = pano.get("rotation")
        locations_out.append({
            "id": pano["id"],
            "location_id": location.get("id"),
            "label": location.get("label"),
            "floor": (location.get("floor") or {}).get("label") or (location.get("floor") or {}).get("id"),
            "room": (location.get("room") or {}).get("id"),
            "position": [position.get("x"), position.get("y"), position.get("z")],
            "rotation": [rotation["x"], rotation["y"], rotation["z"], rotation["w"]] if rotation else None,
            "faces": faces,
        })
        print(f"  [{n}/{len(entries)}] pano {pano['id']}: {sum(f is not None for f in faces)} faces")

    meshes = find_meshes(model_dir)
    manifest = {
        "model_id": model_id,
        "name": model.get("name"),
        "source": "matterport-model-api",
        "resolution": args.resolution,
        "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "conventions": CONVENTIONS,
        "mesh": meshes[0] if meshes else None,
        "meshes": meshes,
        "locations": locations_out,
    }
    (model_dir / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    update_index(model_id, model.get("name"), len(locations_out))
    print(f"Wrote {model_dir / 'manifest.json'}")
    if manifest["mesh"] is None:
        print("No mesh yet. Run `bundles` to see whether a MatterPak is unlocked, or `add-mesh` "
              "with a mesh from the hackathon kit.")


BUNDLES_QUERY = """
{
  model(id: "%MODEL%") {
    id
    bundles { id name availability assets { status filename format url validUntil } }
  }
}
"""

MESH_ASSETS_QUERY = """
{
  model(id: "%MODEL%") {
    assets { meshes { id status format resolution filename url validUntil } }
  }
}
"""


def cmd_bundles(args: argparse.Namespace) -> None:
    model_id = check_id(args.model_id)
    model_dir = DATA / model_id
    downloadable: list[tuple[str, dict]] = []

    data = gql(BUNDLES_QUERY.replace("%MODEL%", model_id))
    for bundle in (data.get("model") or {}).get("bundles") or []:
        assets = bundle.get("assets") or []
        print(f"{bundle['id']:<24} {bundle.get('availability') or '':<12} {bundle.get('name') or ''}")
        for asset in assets:
            has_url = "url" if asset.get("url") else "no url"
            print(f"    {asset.get('status') or '':<11} {asset.get('format') or '':<6} "
                  f"{asset.get('filename') or ''}  ({has_url})")
            if asset.get("url"):
                downloadable.append((bundle["id"], asset))

    try:
        mesh_data = gql(MESH_ASSETS_QUERY.replace("%MODEL%", model_id))
        meshes = ((mesh_data.get("model") or {}).get("assets") or {}).get("meshes") or []
        for mesh in meshes:
            print(f"mesh asset: {mesh.get('status')} {mesh.get('format')} {mesh.get('resolution')} "
                  f"{mesh.get('filename')} ({'url' if mesh.get('url') else 'no url'})")
            if mesh.get("url"):
                downloadable.append(("mesh-assets", mesh))
    except GraphQLError as err:
        print(f"(mesh asset query not accepted by this schema: {err})")

    if not args.download:
        print("\nAdd --download to fetch assets that already have a URL. "
              "Locked bundles have to be unlocked (purchased) in Matterport first.")
        return
    for bundle_id, asset in downloadable:
        filename = safe_name(asset.get("filename") or f"{asset.get('id', 'asset')}.{asset.get('format', 'bin')}")
        dest = model_dir / "bundles" / safe_name(bundle_id) / filename
        print(f"downloading {dest.relative_to(ROOT)}")
        download(asset["url"], dest)
        if dest.suffix.lower() == ".zip":
            safe_extract(dest, dest.with_suffix(""))
    update_manifest_mesh(model_dir)


def cmd_add_mesh(args: argparse.Namespace) -> None:
    model_id = check_id(args.model_id)
    source = Path(args.path).expanduser().resolve()
    mesh_dir = DATA / model_id / "mesh"
    mesh_dir.mkdir(parents=True, exist_ok=True)
    if source.suffix.lower() == ".zip":
        safe_extract(source, mesh_dir)
    elif source.is_dir():
        import shutil
        shutil.copytree(source, mesh_dir / source.name, dirs_exist_ok=True)
    elif source.is_file():
        import shutil
        # An OBJ needs its .mtl and textures beside it, so copy the whole folder.
        shutil.copytree(source.parent, mesh_dir / source.parent.name, dirs_exist_ok=True)
    else:
        sys.exit(f"Not found: {source}")
    update_manifest_mesh(DATA / model_id)


DEMO_QUERY = '{ models(query: "demo:true", include: demo) { totalResults results { id name } } }'


def cmd_demo(_: argparse.Namespace) -> None:
    data = gql(DEMO_QUERY)
    for model in (data.get("models") or {}).get("results") or []:
        print(f"{model['id']}  {model.get('name')}")


LIST_QUERY = """
query L($q: String, $n: Int, $offset: String) {
  models(query: $q, pageSize: $n, offset: $offset) { totalResults nextOffset results { id name created } }
}
"""


def cmd_list(args: argparse.Namespace) -> None:
    data = gql(LIST_QUERY, {"q": args.query, "n": args.limit, "offset": args.offset})
    models = data.get("models") or {}
    for model in models.get("results") or []:
        print(f"{model['id']}  {(model.get('created') or '')[:10]}  {model.get('name')}")
    print(f"({models.get('totalResults')} total; next page: --offset {models.get('nextOffset')})")


TYPE_QUERY = """
query T($name: String!) {
  __type(name: $name) {
    name kind
    fields { name args { name type { ...R } } type { ...R } }
    enumValues { name }
  }
}
fragment R on __Type { name kind ofType { name kind ofType { name kind ofType { name kind } } } }
"""


def type_name(t: dict | None) -> str:
    if not t:
        return "?"
    if t["kind"] == "NON_NULL":
        return type_name(t.get("ofType")) + "!"
    if t["kind"] == "LIST":
        return "[" + type_name(t.get("ofType")) + "]"
    return t.get("name") or "?"


def cmd_introspect(args: argparse.Namespace) -> None:
    info = gql(TYPE_QUERY, {"name": args.type_name}).get("__type")
    if not info:
        sys.exit(f"No type named {args.type_name}.")
    print(f"{info['name']} ({info['kind']})")
    for field in info.get("fields") or []:
        arg_text = ", ".join(f"{a['name']}: {type_name(a['type'])}" for a in field.get("args") or [])
        print(f"  {field['name']}{f'({arg_text})' if arg_text else ''}: {type_name(field['type'])}")
    for value in info.get("enumValues") or []:
        print(f"  = {value['name']}")


def main() -> None:
    load_env_file(ROOT / ".env")
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("demo", help="list the Sandbox demo model id").set_defaults(func=cmd_demo)

    listing = sub.add_parser("list", help="list or search models this account can read")
    listing.add_argument("--query", default=None, help="search text, e.g. a name like '1BR'")
    listing.add_argument("--limit", type=int, default=25)
    listing.add_argument("--offset", default=None)
    listing.set_defaults(func=cmd_list)

    fetch = sub.add_parser("fetch", help="download panoramas and write the manifest")
    fetch.add_argument("model_id")
    fetch.add_argument("--resolution", choices=RESOLUTIONS, default="2k")
    fetch.add_argument("--limit", type=int, default=0, help="only the first N panoramas")
    fetch.set_defaults(func=cmd_fetch)

    bundles = sub.add_parser("bundles", help="show add-on status, optionally download unlocked assets")
    bundles.add_argument("model_id")
    bundles.add_argument("--download", action="store_true")
    bundles.set_defaults(func=cmd_bundles)

    add_mesh = sub.add_parser("add-mesh", help="register a mesh (zip, folder or .obj/.glb) you already have")
    add_mesh.add_argument("model_id")
    add_mesh.add_argument("path")
    add_mesh.set_defaults(func=cmd_add_mesh)

    introspect = sub.add_parser("introspect", help="print the fields of a GraphQL type")
    introspect.add_argument("type_name")
    introspect.set_defaults(func=cmd_introspect)

    args = parser.parse_args()
    try:
        args.func(args)
    except GraphQLError as err:
        sys.exit(f"API error: {err}\nTip: `introspect <TypeName>` shows the live schema's real field names.")


if __name__ == "__main__":
    main()

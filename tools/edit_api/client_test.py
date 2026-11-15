"""Post one edit to the edit API and follow it to the end. Standard library only (Python 3.9+), so it
runs on the web app laptop with no install.

    export EDIT_API_TOKEN=...          # PowerShell: $env:EDIT_API_TOKEN = "..."
    python3 client_test.py --base http://<PC address>:2026
    python3 client_test.py --base ... --model zzvymDx5ty7 --pano <pano id> --yaw 270 --pitch -14 \\
        --command "remove the throw pillows and the tray from the bed" --stream --save out/

Without --pano it uses the scan's first panorama. --stream follows the server-sent events; without
it, the job is polled once a second. --save downloads the preview and the changed faces (scan
pictures: keep them off git and off any upload).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path


def call(base: str, token: str, method: str, path: str, body: dict | None = None, raw: bool = False):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method, headers={
        "Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            payload = resp.read()
            return payload if raw else json.loads(payload)
    except urllib.error.HTTPError as err:
        detail = err.read().decode(errors="replace")
        sys.exit(f"{method} {path} -> HTTP {err.code}: {detail}")


def stream(base: str, token: str, job_id: str) -> None:
    req = urllib.request.Request(f"{base}/edits/{job_id}/events", headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=600) as resp:
        event, data = None, []
        for line in resp:
            line = line.decode().rstrip("\n").rstrip("\r")
            if line.startswith("event:"):
                event = line[6:].strip()
            elif line.startswith("data:"):
                data.append(line[5:].strip())
            elif line == "" and event:
                d = json.loads("\n".join(data)) if data else None
                if event == "step":
                    print(f"  step  {d.get('pano', ''):>2} {d['step']:<12} {d['status']:<8} {d.get('seconds', '')}")
                elif event == "status":
                    print(f"  status {d['status']}  queue position {d.get('queue_position')}")
                else:
                    print(f"  {event}")
                if event in ("done", "failed"):
                    return
                event, data = None, []


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base", default="http://127.0.0.1:2026")
    ap.add_argument("--model", default="zzvymDx5ty7")
    ap.add_argument("--pano", default=None, help="panorama id (default: the scan's first)")
    ap.add_argument("--yaw", type=float, default=270.0)
    ap.add_argument("--pitch", type=float, default=-14.0)
    ap.add_argument("--fov", type=float, default=70.0)
    ap.add_argument("--command", default="remove the throw pillows and the tray from the bed")
    ap.add_argument("--stream", action="store_true")
    ap.add_argument("--save", type=Path, default=None)
    args = ap.parse_args()
    token = os.environ.get("EDIT_API_TOKEN")
    if not token:
        sys.exit("Set EDIT_API_TOKEN in the environment first.")
    base = args.base.rstrip("/")

    place = call(base, token, "GET", f"/places/{args.model}")
    print(f"place {args.model}: downloaded={place['downloaded']} has_mesh={place['has_mesh']} "
          f"panos={len(place['panos'])}")
    pano = args.pano or (place["panos"][0]["id"] if place["panos"] else None)
    if not pano:
        sys.exit("The scan is not downloaded and no --pano was given. POST /places/<id>/fetch first.")

    t0 = time.time()
    job = call(base, token, "POST", "/edits", {
        "place": {"model_id": args.model},
        "start": {"pano_id": pano, "yaw": args.yaw, "pitch": args.pitch, "fov": args.fov},
        "command": args.command})
    print(f"job {job['job_id']}: {job['status']}, queue position {job['queue_position']}")

    if args.stream:
        stream(base, token, job["job_id"])
    seen = 0
    while True:
        job = call(base, token, "GET", f"/edits/{job['job_id']}")
        if not args.stream:
            for s in job["steps"][seen:]:
                print(f"  step  {s.get('pano', ''):>2} {s['step']:<12} {s['status']:<8} {s.get('seconds', '')}")
            seen = len(job["steps"])
        if job["status"] in ("done", "failed", "cancelled"):
            break
        time.sleep(1)

    print(f"{job['status']} after {time.time() - t0:.1f} s")
    if job["status"] != "done":
        sys.exit(f"error: {job['error']}")
    r = job["result"]
    print(f"stub={r['stub']} verdict={r['report']['verdict']} issues={len(r['report']['issues'])}")
    for p in r["panos"]:
        print(f"  pano {p['index']} ({p['id']}) changed faces {p['changed']} verdict {p['verdict']}")
    if args.save:
        args.save.mkdir(parents=True, exist_ok=True)
        (args.save / "preview.jpg").write_bytes(call(base, token, "GET", r["preview"], raw=True))
        for p in r["panos"]:
            for n in p["changed"]:
                (args.save / f"p{p['index']}_f{n}.jpg").write_bytes(call(base, token, "GET", p["faces"][n], raw=True))
        (args.save / "result.json").write_text(json.dumps(r, indent=1))
        print(f"saved to {args.save}")


if __name__ == "__main__":
    main()

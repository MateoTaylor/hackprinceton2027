"""Run one first pass from the command line.

  python -m edit_agent.run --image PATH --request "remove the table lamp" [--preset fast] [--name lamp]
  python -m edit_agent.run --scan MODEL_ID --pano 12 --yaw 30 [--pitch 0] [--fov 75] --request "..."
  python -m edit_agent.run --image PATH --request "..." --target found.json [--mask item.png]
  python -m edit_agent.run --input found.json        (a whole graph input in one file)

Prints each step as it finishes, then the report. Files go to data/edit_agent/runs/<time>-<name>/.
"""
import argparse
import json

from edit_agent.config import DEFAULT_PRESET, PRESETS
from edit_agent.graph import graph


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--input", help="JSON file with a whole graph input, as a finder writes it; other options override it")
    ap.add_argument("--request")
    ap.add_argument("--image")
    ap.add_argument("--scan", help="id of a downloaded scan under data/")
    ap.add_argument("--pano", type=int, default=0)
    ap.add_argument("--yaw", type=float, default=0)
    ap.add_argument("--pitch", type=float, default=0)
    ap.add_argument("--fov", type=float, default=75)
    ap.add_argument("--preset", choices=list(PRESETS), help=f"default: {DEFAULT_PRESET}")
    ap.add_argument("--name")
    ap.add_argument("--target", help="JSON file with a target that was already found (or a report.json); skips locate")
    ap.add_argument("--mask", help="with a target: a mask image, white = the item; skips segment")
    args = ap.parse_args()

    state = {}
    if args.input:
        with open(args.input, encoding="utf-8") as f:
            state = json.load(f)
    for key in ("request", "preset", "name", "mask"):
        if getattr(args, key):
            state[key] = getattr(args, key)
    if args.target:
        with open(args.target, encoding="utf-8") as f:
            given = json.load(f)
        state["target"] = given.get("target", given)
    if args.image:
        state["image"] = args.image
        state.pop("scan", None)
    elif args.scan:
        state["scan"] = {"model": args.scan, "pano": args.pano, "yaw": args.yaw, "pitch": args.pitch, "fov": args.fov}
        state.pop("image", None)
    if not state.get("request"):
        ap.error("give a --request")
    if bool(state.get("image")) == bool(state.get("scan")):
        ap.error("give exactly one of --image and --scan")
    if state.get("mask") and not state.get("target"):
        ap.error("a mask needs a target")

    final = {}
    for mode, chunk in graph.stream(state, stream_mode=["custom", "values"]):
        if mode == "values":
            final = chunk
        elif chunk["status"] == "done":
            extra = {k: v for k, v in chunk.items() if k not in ("step", "status", "seconds")}
            print(f"{chunk['step']:9s} {chunk['seconds']:6.1f} s  {json.dumps(extra) if extra else ''}", flush=True)

    result = final["report"]
    print(f"\n{result['verdict'].upper()}: {result['summary']}")
    for n, issue in enumerate(result["issues"], 1):
        print(f"  {n}. [severity {issue['severity']}, {issue['source']}] {issue['kind']}: {issue['evidence']}")
        print(f"     second pass: {issue['repair']}")
    for issue in result["notes"]:
        print(f"  note [severity {issue['severity']}] {issue['kind']}: {issue['evidence']}")
    print("scores:", json.dumps(result["scores"]))
    print("total:", round(sum(t["seconds"] for t in final["timings"].values()), 1), "s")
    print("files:", final["run_dir"])


if __name__ == "__main__":
    main()

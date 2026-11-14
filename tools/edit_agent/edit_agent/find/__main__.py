"""Find the thing to edit, from the command line. Writes found.json, a whole input of first_pass.

  python -m edit_agent.find point --scan zzvymDx5ty7 --pano 1 --yaw 215 --pitch -15 --at 520,430 [--request "..."]
  python -m edit_agent.find point --image PATH --at 520,430 [--request "..."]
  python -m edit_agent.find point ... --highlight          SAM's outlines of the click only (~0.5 s warm)
  python -m edit_agent.find point ... --mask OUTLINE.png   name an outline the user chose, write found.json

  python -m edit_agent.find look --scan zzvymDx5ty7 --pano 1 --yaw 172 --pitch -12 --request "remove the piano"
                     the view and words: here first, then the other directions and the nearest panoramas
  python -m edit_agent.find search --scan zzvymDx5ty7 --request "remove the table lamp" [--near 1]
                     words alone: the scan's inventory (built on first use, ~1.5 min), then locate
  python -m edit_agent.find inventory --scan zzvymDx5ty7 [--rebuild]    build or show the inventory

  --at X,Y      the click, on the 0-1000 scale of the view (the scale of bbox_2d)
  --marker M    how the click is shown to the VLM: both (ring and coordinates, default), ring, coords
  --out PATH    also copy found.json there

Then:  python -m edit_agent.run --input <found.json>
Files go to data/edit_agent/find/runs/<time>-<name>/ (git-ignored).
"""
import argparse
import json
import shutil

from edit_agent.config import DEFAULT_PRESET, PRESETS
from edit_agent.find.graph import graph
from edit_agent.find.pointer import MARKERS


def view_args(p):
    p.add_argument("--image")
    p.add_argument("--scan", help="id of a downloaded scan under data/")
    p.add_argument("--pano", type=int, default=0)
    p.add_argument("--yaw", type=float, default=0)
    p.add_argument("--pitch", type=float, default=0)
    p.add_argument("--fov", type=float, default=75)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="mode", required=True)
    pt = sub.add_parser("point", help="the user clicked a spot in the view")
    view_args(pt)
    pt.add_argument("--at", required=True, help="X,Y on the 0-1000 scale of the view")
    pt.add_argument("--request", default="")
    pt.add_argument("--marker", choices=MARKERS, default="both")
    pt.add_argument("--highlight", action="store_true", help="stop after SAM: the outlines of the click")
    pt.add_argument("--mask", help="an outline the user chose (from --highlight): skip SAM, only name it")
    lk = sub.add_parser("look", help="the view the user is looking at, and words")
    view_args(lk)
    lk.add_argument("--request", required=True)
    se = sub.add_parser("search", help="words alone: search the whole scan")
    se.add_argument("--scan", required=True)
    se.add_argument("--request", required=True)
    se.add_argument("--near", type=int, help="the panorama the user is at, searched first")
    inv = sub.add_parser("inventory", help="the names of the things in every view of a scan")
    inv.add_argument("--scan", required=True)
    inv.add_argument("--rebuild", action="store_true")
    for p in (pt, lk, se):
        p.add_argument("--preset", choices=list(PRESETS), help=f"default: {DEFAULT_PRESET}; passed on to first_pass")
        p.add_argument("--name")
        p.add_argument("--out")
    args = ap.parse_args()

    if args.mode == "inventory":
        return inventory(args)
    state = {k: getattr(args, k) for k in ("request", "preset", "name", "marker", "highlight", "mask")
             if getattr(args, k, None)}
    if args.mode == "search":
        state["scan"] = {"model": args.scan}
        if args.near is not None:
            state["near"] = args.near
        return run(state, args)
    if bool(args.image) == bool(args.scan):
        ap.error("give exactly one of --image and --scan")
    if args.image:
        state["image"] = args.image
    else:
        state["scan"] = {"model": args.scan, "pano": args.pano, "yaw": args.yaw, "pitch": args.pitch, "fov": args.fov}
    if args.mode == "point":
        state["point"] = [float(v) for v in args.at.split(",")]
    return run(state, args)


def inventory(args):
    from edit_agent.find import search
    inv = None if args.rebuild else search.load_inventory(args.scan)
    if inv is None:
        def say(e):
            print(f"  pano {e['pano']} yaw {e['yaw']:5.1f}  {e['seconds']:4.1f} s  {', '.join(e['names'])}", flush=True)
        inv = search.build_inventory(args.scan, say)
    names = sorted({n for v in inv["views"] for n in v["names"]})
    print(f"{len(inv['views'])} views, {len(names)} names, built {inv['built']} in {inv['seconds']} s")
    print(search.inventory_path(args.scan))


def run(state, args):
    final = {}
    for mode, chunk in graph.stream(state, stream_mode=["custom", "values"]):
        if mode == "values":
            final = chunk
        elif chunk["step"] == "search" and chunk["status"] in ("seen", "located"):
            print(f"  {chunk['status']:7s} pano {chunk['pano']} yaw {chunk['yaw']:5.1f}: {chunk['found']}  {chunk.get('item') or ''}",
                  flush=True)
        elif chunk["step"] == "search" and chunk["status"] == "matched":
            print(f"  inventory matches: {chunk['hits']}", flush=True)
        elif chunk["status"] == "done":
            extra = {k: v for k, v in chunk.items() if k not in ("step", "status", "seconds")}
            print(f"{chunk['step']:9s} {chunk['seconds']:6.1f} s  {json.dumps(extra) if extra else ''}", flush=True)

    print()
    for c in final.get("candidates") or []:
        if "name" in c:
            star = "*" if c["name"] == final.get("default") else " "
            print(f" {star}{c['name']}: {c['share']:.1%} of the view, SAM {c['score']}, box {c['bbox_2d']}  {c['mask']}")
        else:
            sc = c["scan"]
            print(f"  candidate: pano {sc['pano']} yaw {sc['yaw']}: {c['item']} {c['labels']}, {c['share']:.1%} of the view")
    if final["status"] == "highlighted":
        print("total:", round(sum(t["seconds"] for t in final["timings"].values()), 2), "s")
        print("sheet:", final["sheet"])
        return
    found = final["found"]
    target = found["target"]
    outline = f", outline {final.get('default')}" if final.get("default") else ""
    print(f"{final['status'].upper()} ({final['reason']}{outline}): {target['item']}")
    if "pano" in found.get("scan", {}):
        sc = found["scan"]
        print(f"  view: pano {sc['pano']}, yaw {sc.get('yaw')}, pitch {sc.get('pitch')}, fov {sc.get('fov')}")
    for b in target["boxes"]:
        print(f"  {b['label']}: {b['bbox_2d']}")
    print(f"  instruction: {target['instruction']}")
    print(f"  behind: {target['behind']}")
    if found["find"].get("recentred"):
        print(f"  recentred: {json.dumps(found['find']['recentred'])}")
    print("total:", round(sum(t["seconds"] for t in final["timings"].values()), 1), "s")
    print("found:", final["found_path"])
    print("sheet:", final["sheet"])
    if args.out:
        shutil.copyfile(final["found_path"], args.out)
        print("copied to", args.out)


if __name__ == "__main__":
    main()

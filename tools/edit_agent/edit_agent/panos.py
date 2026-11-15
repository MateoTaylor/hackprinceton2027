"""Every panorama that sees the thing, as a LangGraph graph: the first view, then each other view in turn.

  first_view -> plan -> other_view -> other_view -> ... -> finish -> END
       |          |
       +----------+-- nothing edited, a picture and not a scan, or no mesh: only the first view --> finish

first_view runs the first_pass graph (graph.py) on the view the request was made in: locate, segment,
generate, paste, the checks and at most one repair. plan lifts what that view removed (or changed) onto the
scan mesh as 5 cm voxels and picks the other panoramas that see it. other_view runs first_pass again on
each of them, one at a time, since they share the one GPU. The thing is found there through the mesh,
not by the VLM: the mesh's outline of it is sharpened by SAM (change/views.py, Mateo-Retexture-Agent's),
so locate and segment are skipped and every view edits the same things.

A removal lifts each box of the first view on its own: SAM keeps one outline per prompt, and three pillows
and a tray are four outlines, not one. A box that is hidden in a view is left out there. A change lifts the
thing whole, and each view also gets the first view's result redrawn into its own viewpoint through the mesh
(the `guide`), when that covers enough of the thing, so the new texture matches across views. A removal gets
no guide: what was behind the thing is not on the mesh, so each view draws its own.

Input: as first_pass's, with a `scan` view (a picture alone is edited as one view), plus `max_views`.
Output: `views`, one record per edited panorama, and an overall `report`. Each node sends progress on the
"custom" stream; first_pass's own events are passed on with the view's number and panorama added.
"""
import json
import operator
import re
import time
from collections import Counter
from datetime import datetime
from pathlib import Path
from typing import Annotated, TypedDict

import numpy as np
from langgraph.config import get_stream_writer
from langgraph.graph import END, START, StateGraph
from PIL import Image, ImageDraw

from edit_agent.config import DEFAULT_PRESET, PRESETS, RUNS          # first: it puts tools/qwen_test on sys.path
from edit_agent.change import views
from edit_agent.find.common import mask_box, to_1000
from edit_agent.graph import EditInput
from edit_agent.graph import graph as first_pass
from edit_agent import steps
from lift import VoxelItem, grow, hit_points, shrink

MIN_SEEN = 0.3            # share of the thing's voxels a panorama must see (retexture's pans uses the same)
MIN_DISTANCE = 0.8        # metres: a nearer panorama frames a bare slab of the thing
MAX_VIEWS = 4             # panoramas edited in all, the first included
MIN_GUIDE_FILL = 0.5      # a change's guide must cover this share of the thing, else the view is edited alone
MIN_PART_PX = 50          # a box with fewer mask pixels than this is not lifted on its own


class ViewsInput(EditInput, total=False):
    max_views: int          # panoramas edited in all, the first included (default MAX_VIEWS)


class ViewsState(ViewsInput, total=False):
    folder: str             # this run's folder: one p<pano>/ folder per view inside
    first: dict             # the first view's record, with its target and mask, for plan
    todo: list              # [{pano, scan, distance_m, seen}] for other_view, in order
    lifted: dict            # paths of the voxel files: {whole, keep, parts: [{label, path}]}
    share: list             # for each panorama, the share of the thing it sees
    single_view: str        # why only the first view was edited
    at: int                 # other views tried so far
    views: Annotated[list, operator.add]
    skipped: Annotated[list, operator.add]
    timings: Annotated[dict, operator.or_]
    report: dict


class ViewsOutput(TypedDict, total=False):
    folder: str
    views: list
    skipped: list
    single_view: str
    share: list
    timings: dict
    report: dict


def node(name):
    """Announce a node on the custom stream and time it, as graph.step does."""
    def wrap(fn):
        def run(state):
            say = get_stream_writer()
            label, tag = name, {}
            if name == "other_view":
                at = state.get("at", 0)
                label, tag = f"{name}_{at + 1}", {"view": at + 1, "pano": state["todo"][at]["pano"]}
            elif name == "first_view" and state.get("scan"):
                tag = {"view": 0, "pano": state["scan"]["pano"]}
            say({**tag, "step": label, "status": "started"})
            t0 = time.time()
            out = fn(state, PRESETS[state.get("preset") or DEFAULT_PRESET], say)
            timing = {"seconds": round(time.time() - t0, 1), **out.pop("detail", {})}
            say({**tag, "step": label, "status": "done", **timing})
            return {**out, "timings": {label: timing}}
        run.__name__ = name
        return run
    return wrap


def _edit(inp, tag, say):
    """first_pass on one view. Its progress goes out again on this graph's stream, tagged with the view."""
    final = {}
    for mode, chunk in first_pass.stream(inp, stream_mode=["custom", "values"]):
        if mode == "custom":
            say({**tag, **chunk})
        else:
            final = chunk
    return final


def _record(final, scan, n):
    """What a view hands on: where its pictures are and what its report says."""
    rep = final.get("report") or {}
    return {"view": n, "pano": scan["pano"] if scan else None,
            **({k: scan.get(k) for k in ("yaw", "pitch", "fov")} if scan else {}),
            "scan": scan, "run_dir": final.get("run_dir"), "before": final.get("view"), "edited": final.get("edited"),
            "paste_mask": final.get("paste_mask"), "mask": final.get("mask"),
            "verdict": rep.get("verdict"), "summary": rep.get("summary"),
            "issues": [{k: i.get(k) for k in ("kind", "severity", "evidence")} for i in rep.get("issues", [])],
            "notes": [{k: i.get(k) for k in ("kind", "severity", "evidence")} for i in rep.get("notes", [])],
            "repairs": [{k: r.get(k) for k in ("action", "what", "taken", "seed")} for r in final.get("repairs") or []],
            "seconds": round(sum(t["seconds"] for t in (final.get("timings") or {}).values()), 1)}


def _bool(path):
    return np.asarray(Image.open(path).convert("L")) > 127


@node("first_view")
def first_view(state, preset, say):
    # Cleaned whichever it comes from: the name reaches a folder name, and a request may come off the network.
    label = re.sub(r"[^a-z0-9]+", "-", (state.get("name") or state["request"]).lower()).strip("-")[:40] or "edit"
    folder = RUNS / f"{datetime.now():%Y%m%d-%H%M%S}-{label}"
    folder.mkdir(parents=True)
    scan = state.get("scan")
    inp = {k: state[k] for k in ("request", "image", "scan", "preset", "target", "mask", "raw") if state.get(k)}
    inp["run_dir"] = str(folder / (f"p{scan['pano']}" if scan else "picture"))
    final = _edit(inp, {"view": 0, "pano": scan["pano"] if scan else None}, say)
    record = _record(final, scan, 0)
    first = {**record, "target": final.get("target"), "size": list(Image.open(final["view"]).size)}
    return {"folder": str(folder), "first": first, "views": [record], "at": 0, "skipped": [],
            "detail": {"verdict": record["verdict"]}}


def _instruction(boxes):
    """What the image model is told in another view: the lifted parts this view sees, by their labels
    from the first view (a second removal's finds among them: "dark grey tray with cup and box").

    The first view's own sentence is not reused. It may name things this view does not show: "Remove the
    lamp and the green cup and the vase. Leave the tray with box as it is." was about a tray on the bed,
    out of sight from the dresser's other side, and there the image model drew a tray with a box on the
    cleared dresser."""
    count = Counter(b["label"] for b in boxes)
    return "Remove " + " and ".join(f"every {label}" if k > 1 else f"the {label}" for label, k in count.items()) + "."


def _near(cam, core, box, whole, margin=0.15, edge=4, step=2):
    """Mesh points around one box that the first view left out (the bed under a pillow): views.lift_keep for
    one box, with every removed thing's pixels taken out, not only this box's, so that a neighbouring
    pillow's edge is never kept. Returns world points (k, 3)."""
    h, w = core.shape
    x0, y0, x1, y1 = box
    dx, dy = margin * (x1 - x0), margin * (y1 - y0)
    region = np.zeros_like(core)
    region[int(max(0, y0 - dy)):int(min(h, y1 + dy)), int(max(0, x0 - dx)):int(min(w, x1 + dx))] = True
    region &= ~grow(core, edge)
    pts = hit_points(views.search._mesh(cam["model"]), views.camera(cam, (w, h)), region, step)
    pts = pts[np.isfinite(pts[..., 0])]
    return pts[~whole.inside(pts)] if len(pts) else pts.reshape(0, 3)


@node("plan")
def plan(state, preset, say):
    first, scan = state["first"], state.get("scan")
    target = first.get("target") or {}
    why = None
    if not scan:
        why = "a picture was given, not a scan view"
    elif not first.get("edited") or not target.get("boxes"):
        why = "nothing was edited in the first view"
    elif views.search._mesh(scan["model"]) is None:
        why = "the scan has no mesh"
    if why:
        return {"single_view": why, "todo": [], "detail": {"single_view": why}}
    folder = Path(state["folder"]) / "lifted"
    folder.mkdir()
    cam = {**scan, "fov": scan.get("fov", 75)}
    mask = _bool(first["mask"])
    # The mask as SAM drew it: the graph grows it to cover the soft edge, and a ray through that edge lands
    # on the wall behind. lift_mask erodes 2 px more itself.
    core = shrink(mask, round(preset.mask_grow * max(mask.shape)))
    core = core if core.sum() > 200 else mask
    # A removal is lifted box by box. The mesh cast tests each ray against every triangle in the cone of all
    # the rays, so one wide region costs far more than the same pixels in narrow pieces: the bed's pillows
    # and tray took 17 s whole and 5 s as five boxes, and the ring around them 100 s whole.
    parts, keep_pts = [], []
    if target["kind"] == "remove":
        for k, b in enumerate(target["boxes"]):
            x0, y0, x1, y1 = b["box"]
            part = np.zeros_like(core)
            part[y0:y1, x0:x1] = core[y0:y1, x0:x1]
            item = views.lift_mask(cam, part) if part.sum() >= MIN_PART_PX else None
            if item is not None:
                parts.append((k, b["label"], item))
    if parts:
        whole = VoxelItem(np.concatenate([item.keys for _, _, item in parts]))
        for k, _, _ in parts:
            keep_pts.append(_near(cam, core, target["boxes"][k]["box"], whole))
        keep_pts = np.concatenate(keep_pts)
        keep = VoxelItem.from_points(keep_pts) if len(keep_pts) >= 20 else None
    else:
        whole = views.lift_mask(cam, core)
        keep = views.lift_keep(cam, core, whole) if whole is not None else None
    if whole is None:
        why = "the thing is not on the mesh"
        return {"single_view": why, "todo": [], "detail": {"single_view": why}}
    whole.save(folder / "whole.npz")
    lifted = {"whole": str(folder / "whole.npz"), "keep": None, "parts": []}
    if keep is not None:
        keep.save(folder / "keep.npz")
        lifted["keep"] = str(folder / "keep.npz")
    for k, label, item in parts:
        item.save(folder / f"part{k}.npz")
        lifted["parts"].append({"label": label, "path": str(folder / f"part{k}.npz")})
    if not lifted["parts"]:
        from edit_agent.change.spec import label_of
        lifted["parts"] = [{"label": label_of(target), "path": lifted["whole"]}]
    share = views.seen_share(scan["model"], whole)
    seen = sorted((j for j, v in enumerate(share) if j != scan["pano"] and v >= MIN_SEEN), key=lambda j: -share[j])
    todo, near = [], []
    for j in seen:
        vscan, dist = views.frame_on(scan["model"], j, whole, preset.work_px)
        if dist < MIN_DISTANCE:
            near.append({"pano": j, "why": f"{dist} m from the thing, too close"})
        elif len(todo) < (state.get("max_views") or MAX_VIEWS) - 1:
            todo.append({"pano": j, "scan": vscan, "distance_m": dist, "seen": share[j]})
    say({"step": "plan", "status": "chosen", "panos": [t["pano"] for t in todo]})
    return {"todo": todo, "lifted": lifted, "share": share, "skipped": near,
            "detail": {"panos": [t["pano"] for t in todo], "parts": len(lifted["parts"]), "voxels": len(whole.keys)}}


def after_plan(state):
    return "other_view" if state.get("todo") else "finish"


def outline(view, vscan, lifted, vdir):
    """Each lifted part's outline in a view: the mesh's outline sharpened by SAM, less what the first view
    left out next to it (`keep`). Returns (masks, boxes on the 0-1000 scale, labels hidden here, SAM's info)."""
    size = Image.open(view).size
    keep = VoxelItem.load(lifted["keep"]) if lifted.get("keep") else None
    masks, boxes, hidden, found = [], [], [], {}
    for k, part in enumerate(lifted["parts"]):
        m, info = views.sam_mask(view, vscan, VoxelItem.load(part["path"]), vdir, tag=f"part{k}", keep=keep)
        found[f"part{k}"] = {"label": part["label"], **{x: info.get(x) for x in ("mesh_px", "iou_mesh", "mask_from")}}
        if m is None or m.sum() < 30:
            hidden.append(part["label"])
            continue
        masks.append(m)
        boxes.append({"label": part["label"], "bbox_2d": to_1000(mask_box(m), size)})
    return masks, boxes, hidden, found


@node("other_view")
def other_view(state, preset, say):
    n = state.get("at", 0)
    todo, first = state["todo"][n], state["first"]
    j, vscan = todo["pano"], todo["scan"]
    vdir = Path(state["folder"]) / f"p{j}"
    vdir.mkdir()
    view, size = steps.prepare(None, vscan, preset, vdir)
    masks, boxes, hidden, found = outline(view, vscan, state["lifted"], vdir)
    out = {"at": n + 1}
    if not masks:
        out["skipped"] = [{"pano": j, "why": "the thing is hidden in the framed view", "found": found}]
        return {**out, "detail": {"pano": j, "skipped": "hidden"}}
    union = np.logical_or.reduce(masks)
    mask_path = vdir / "mask_given.png"
    Image.fromarray(union.astype(np.uint8) * 255).save(mask_path)
    given = first["target"]
    target = {k: given.get(k) for k in ("item", "kind", "behind", "instruction")}
    target["boxes"] = boxes
    inp = {"request": state["request"], "scan": vscan, "preset": state.get("preset") or DEFAULT_PRESET,
           "target": target, "mask": str(mask_path), "run_dir": str(vdir), "carried": True}
    extra = {}
    if given["kind"] == "change":
        target["change"] = given["change"]
        guide, filled = views.guide(view, vscan, union, {**state["scan"], "fov": state["scan"].get("fov", 75)},
                                    first["edited"], vdir / "guide.png")
        extra = {"guide_filled": round(float(filled), 3), "variant": "guide" if filled >= MIN_GUIDE_FILL else "alone"}
        if filled >= MIN_GUIDE_FILL:
            from edit_agent.change import wording
            from edit_agent.change.generate import shrunk
            from edit_agent.change.spec import label_of
            inp["refs"] = [str(shrunk(guide, vdir / "context_guide.png"))]
            inp["note"] = wording.context_note("guide", label_of(given), given["change"]["to"])
    else:
        target["instruction"] = _instruction(boxes)
    final = _edit(inp, {"view": n + 1, "pano": j}, say)
    record = {**_record(final, vscan, n + 1), "distance_m": todo["distance_m"], "seen": todo["seen"],
              "hidden": hidden, "found": found, **extra}
    out["views"] = [record]
    return {**out, "detail": {"pano": j, "verdict": record["verdict"], "hidden": hidden}}


def after_view(state):
    return "other_view" if state.get("at", 0) < len(state.get("todo") or []) else "finish"


def _tile(path, label, side=360):
    img = Image.open(path).convert("RGB")
    img = img.resize((side, round(side * img.size[1] / img.size[0])), Image.LANCZOS)
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, 8 + 6 * len(label), 16], fill=(0, 0, 0))
    d.text((4, 3), label, fill=(255, 255, 0))
    return img


def sheet(records, out, side=360):
    """One row per view: the photo, then the result."""
    rows = [[_tile(r["before"], f"pano {r['pano']} before", side),
             _tile(r["edited"], f"pano {r['pano']} after: {r['verdict']}", side)] for r in records if r.get("edited")]
    if not rows:
        return None
    img = Image.new("RGB", (2 * side, sum(r[0].size[1] for r in rows)), (30, 30, 30))
    y = 0
    for row in rows:
        for i, tile in enumerate(row):
            img.paste(tile, (i * side, y))
        y += row[0].size[1]
    img.save(out, quality=88)
    return out


@node("finish")
def finish(state, preset, say):
    records = state.get("views") or []
    verdict = "pass" if records and all(r["verdict"] == "pass" for r in records) else "fix"
    parts = [f"pano {r['pano']}: {r['verdict']}" + (f" ({', '.join(i['kind'] for i in r['issues'])})" if r["issues"] else "")
             for r in records]
    edited = sum(1 for r in records if r.get("edited"))
    summary = f"{edited} view{'s' * (edited != 1)} edited. " + "; ".join(parts) + "."
    if state.get("single_view"):
        summary += f" Only the first view: {state['single_view']}."
    skipped = state.get("skipped") or []
    if skipped:
        summary += " Skipped: " + "; ".join(f"pano {s['pano']} ({s['why']})" for s in skipped) + "."
    folder = Path(state["folder"])
    pic = sheet(records, folder / "views.jpg")
    result = {"verdict": verdict, "summary": summary, "views": len(records), "sheet": str(pic) if pic else None}
    record = {"request": state["request"], "scan": state.get("scan"), "preset": state.get("preset"),
              "single_view": state.get("single_view"), "share": state.get("share"), "views": records,
              "skipped": skipped, "lifted": state.get("lifted"), "timings": state.get("timings"), "report": result}
    (folder / "views.json").write_text(json.dumps(record, indent=2, default=str), encoding="utf-8")
    return {"report": result, "detail": {"verdict": verdict}}


builder = StateGraph(ViewsState, input_schema=ViewsInput, output_schema=ViewsOutput)
for fn in (first_view, plan, other_view, finish):
    builder.add_node(fn.__name__, fn)
builder.add_edge(START, "first_view")
builder.add_edge("first_view", "plan")
builder.add_conditional_edges("plan", after_plan, ["other_view", "finish"])
builder.add_conditional_edges("other_view", after_view, ["other_view", "finish"])
builder.add_edge("finish", END)

graph = builder.compile(name="all_views")


def main():
    """python -m edit_agent.panos --scan MODEL --pano 6 --yaw 270 --pitch -14 --fov 70 --request "..."
    or --input found.json (a finder's output: request, scan, target, mask). Prints each step, then each view."""
    import argparse
    ap = argparse.ArgumentParser(prog="python -m edit_agent.panos")
    ap.add_argument("--input")
    ap.add_argument("--request")
    ap.add_argument("--scan")
    ap.add_argument("--pano", type=int, default=0)
    ap.add_argument("--yaw", type=float, default=0)
    ap.add_argument("--pitch", type=float, default=0)
    ap.add_argument("--fov", type=float, default=75)
    ap.add_argument("--preset", choices=list(PRESETS))
    ap.add_argument("--name")
    ap.add_argument("--max-views", type=int)
    args = ap.parse_args()
    state = json.loads(Path(args.input).read_text(encoding="utf-8")) if args.input else {}
    for key in ("request", "preset", "name"):
        if getattr(args, key):
            state[key] = getattr(args, key)
    if args.max_views:
        state["max_views"] = args.max_views
    if args.scan:
        state["scan"] = {"model": args.scan, "pano": args.pano, "yaw": args.yaw, "pitch": args.pitch, "fov": args.fov}
    if not state.get("request") or not state.get("scan"):
        ap.error("give a --request and a --scan view (or an --input file with both)")
    final = {}
    for mode, chunk in graph.stream(state, stream_mode=["custom", "values"]):
        if mode == "values":
            final = chunk
        elif chunk.get("status") == "done":
            where = f"view {chunk['view']} pano {chunk['pano']} " if "view" in chunk else ""
            extra = {k: v for k, v in chunk.items() if k not in ("step", "status", "seconds", "view", "pano")}
            print(f"{where}{chunk['step']:11s} {chunk['seconds']:6.1f} s  {json.dumps(extra) if extra else ''}", flush=True)
    print(f"\n{final['report']['verdict'].upper()}: {final['report']['summary']}")
    for r in final["views"]:
        print(f"  pano {r['pano']}: {r['verdict']} in {r['seconds']} s, {r['run_dir']}")
    print("files:", final["folder"])


if __name__ == "__main__":
    main()

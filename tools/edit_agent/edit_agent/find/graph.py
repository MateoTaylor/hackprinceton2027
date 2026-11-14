"""The finder as a LangGraph graph, `find_target`. Its result is a whole input of the graph `first_pass`.

  prepare -> highlight                       highlight only: SAM's outlines of the click, no VLM (~0.5 s)
  prepare -> point -> write                  a click: outline, name it, write found.json (~7 s)
               |  ^
               v  |
             recenter                        the outline touches the edge of the view: look again,
                                             centred on it (once, scan views only)
  prepare -> look -> deliver                 a view and words: here, else the other directions and
                                             the nearest panoramas (search.look_around)
  prepare -> search -> deliver               words alone: the scan's inventory, then locate (search.search)

The mode follows from the input: a `point` is a click; a `scan` with a `pano` and no click is a view
and words; a `scan` with only a `model` is words alone (`near`: the user's panorama, if known).
Input for a click: the view (`scan` or `image`), the click (`point`, 0-1000 of the view) and optionally a
`request`. `highlight: true` stops after SAM. `mask` (one of the highlighted outlines, chosen by the
user) skips SAM and only names it. Output: `found` (the first_pass input, also written to
found.json), `status`, `reason`, `candidates` (the outlines), `sheet` and `timings`.

Each node sends progress on the "custom" stream ({step, status, seconds, ...}), like first_pass.
A UI can show the outlines from the event {"step": "point", "status": "highlighted"} before the VLM
has answered.
"""
import operator
import time
from pathlib import Path
from typing import Annotated, TypedDict

import numpy as np
from langgraph.config import get_stream_writer
from langgraph.graph import END, START, StateGraph
from PIL import Image

from edit_agent import gpu, steps
from edit_agent.config import DEFAULT_PRESET, PRESETS
from edit_agent.find import common, pointer, search

RECENTER_MAX_SHARE = 0.35      # a bigger outline that touches the edge is a surface, not a cut-off object
render = search.render         # scan views, rendered once and reused so SAM's image features stay cached


class FindInput(TypedDict, total=False):
    request: str            # what to do, in plain words; optional with a click ("remove" is assumed)
    image: str              # path to a picture on this PC, or
    scan: dict              # {"model": id, "pano": index, "yaw": deg, "pitch": deg, "fov": deg}
    point: list             # [x, y] on the 0-1000 scale of the view: the user's click
    highlight: bool         # stop after SAM and return its outlines of the click
    mask: str               # an outline the user chose (a `candidates` path): skip SAM, only name it
    preset: str             # a name from config.PRESETS; passed on to first_pass when given
    name: str               # optional label for the run folder
    marker: str             # how the click is shown to the VLM: "both" (default), "ring" or "coords"
    near: int               # words alone: the panorama the user is at, searched first


class FindOutput(TypedDict, total=False):
    found: dict             # the input for first_pass
    found_path: str
    status: str             # "found", "not_found" or "highlighted"
    reason: str
    candidates: list        # a click: SAM's outlines, small to large {name, mask, score, share, bbox_2d};
                            # a search: every view where the thing was found {scan, item, labels, share, mask}
    several: bool           # a search found more than one thing that fits: ask the user
    default: str            # the name of the outline handed over (or proposed, for highlight)
    sheet: str
    run_dir: str
    timings: dict


class FindState(FindInput, FindOutput, total=False):
    view: str
    size: list
    work_dir: str
    answer: dict            # the VLM's reading of the click
    described: dict         # the VLM's naming of the chosen outline, when it disagreed with the reading
    outlines: dict          # per outline: share, SAM score, contains the click, agreement with the VLM box
    target: dict
    cut_off: bool
    previous: dict          # the result before a recenter, kept in case the new view does worse
    mode: str               # "point", "look" or "search"
    tried: list             # a search: each view asked, with the answer
    hits: list              # a search: the inventory names that fit the request
    timings: Annotated[dict, operator.or_]


def step(name):
    """Wrap a node: announce it on the custom stream and record how long it took."""
    def wrap(fn):
        def node(state):
            say = get_stream_writer()
            say({"step": name, "status": "started"})
            t0 = time.time()
            out = fn(state, PRESETS[state.get("preset") or DEFAULT_PRESET], say)
            timing = {"seconds": round(time.time() - t0, 1), **out.pop("detail", {})}
            say({"step": name, "status": "done", **timing})
            done = state.get("timings") or {}
            key = name if name not in done else f"{name}_{sum(k.startswith(name) for k in done) + 1}"
            return {**out, "timings": {key: timing}}
        node.__name__ = name
        return node
    return wrap


def public(ladder, size):
    """Outlines as the output shows them: paths, not pixels."""
    return [{"name": c["name"], "mask": c["path"], "score": c["score"],
             "share": round(c["area"] / (size[0] * size[1]), 4), "bbox_2d": common.to_1000(c["box"], size)}
            for c in ladder]


def mode_of(state):
    scan = state.get("scan") or {}
    if state.get("point") is not None:
        if bool(state.get("image")) == bool(state.get("scan")):
            raise ValueError("give exactly one of `image` and `scan`")
        p = state["point"]
        if len(p) != 2 or not all(0 <= v <= 1000 for v in p):
            raise ValueError(f"`point` is [x, y] on the 0-1000 scale of the view, got {p}")
        return "point"
    if not state.get("request"):
        raise ValueError("without a click (`point`), give a `request`")
    if state.get("image"):
        raise ValueError("a picture and words without a click: give them to first_pass, whose locate does that")
    if scan.get("pano") is not None:
        return "look"
    if scan.get("model"):
        return "search"
    raise ValueError('give `scan`: a view {"model", "pano", "yaw", "pitch", "fov"}, or {"model"} to search the scan')


@step("prepare")
def prepare(state, preset, say):
    mode = mode_of(state)
    run = common.run_dir(state.get("name") or state.get("request") or ("highlight" if state.get("highlight") else "click"))
    out = {"mode": mode, "run_dir": str(run), "work_dir": str(run)}
    if mode in ("point", "look"):
        if state.get("scan"):
            view, size = render(state["scan"], preset, run)
        else:
            view, size = steps.prepare(state["image"], None, preset, run)
        out.update(view=str(view), size=list(size))
    return {**out, "detail": {"mode": mode, **({"size": out["size"]} if "size" in out else {})}}


@step("highlight")
def highlight(state, preset, say):
    run, size = Path(state["run_dir"]), tuple(state["size"])
    ladder, info = pointer.highlight(state["view"], state["point"], run)        # the SAM server takes the lock
    pick = pointer.default(ladder, state["point"], size)
    cands = public(ladder, size)
    caption = "  ".join(f"{c['name']}: {c['share']:.1%} of the view, SAM {c['score']}" for c in cands)
    sheet = common.sheet(state["view"], run / "sheet.jpg", pick["mask"] if pick else None,
                         common.to_px(state["point"], size), [c["box"] for c in ladder], pick["box"] if pick else None,
                         f"HIGHLIGHT, proposed {pick['name'] if pick else 'nothing'}\n{caption}")
    return {"status": "highlighted", "reason": "SAM only", "candidates": cands,
            "default": pick["name"] if pick else None, "sheet": str(sheet), "detail": info}


@step("point")
def point(state, preset, say):
    run, size, view, click = Path(state["work_dir"]), tuple(state["size"]), state["view"], state["point"]
    request, marker = state.get("request") or "", state.get("marker") or "both"
    if marker not in pointer.MARKERS:
        raise ValueError(f"`marker` is one of {pointer.MARKERS}")
    detail, answer, described, refined, record = {}, None, None, {}, {}
    given = state.get("mask") if not state.get("previous") else None
    with gpu.exclusive():                      # SAM and VLM as one short batch
        if given:
            m = np.asarray(Image.open(given).convert("L").resize(size, Image.NEAREST)) > 127
            ladder = [{"name": "given", "mask": m, "box": common.mask_box(m), "area": int(m.sum()), "score": None,
                       "path": given}]
        else:
            ladder, info = pointer.highlight(view, click, run, lock=False)
            detail.update(highlight_s=info["sam_s"], sam_start_s=info["sam_start_s"])
            say({"step": "point", "status": "highlighted", "candidates": public(ladder, size),
                 "default": (pointer.default(ladder, click, size) or {}).get("name")})
        with gpu.vlm(preset, log=run / "llama-server.log") as server:
            detail["vlm_load_s"] = server.load_s
            if given:
                pick, reason = ladder[0], "given"
            else:
                answer, info = pointer.ask(server, pointer.mark(view, click, run, marker), click, request, preset, marker)
                detail["ask_s"] = info["answer_s"]
                say({"step": "point", "status": "asked", "found": answer["found"], "item": answer["item"]})
                if not answer["found"] or pointer.surface(answer):
                    why = "nothing to edit" if not answer["found"] else f'only "{answer["item"]}"'
                    return {"status": "not_found", "reason": f"the VLM sees {why} at the click",
                            "answer": answer, "outlines": {}, "candidates": public(ladder, size), "detail": detail}
                if pointer.about_ring(answer):          # it read the marker, not the room: SAM decides
                    detail["ring_read"] = True
                    answer = {**answer, "found": False, "boxes": []}
                else:
                    refined, info = pointer.refine(view, click, answer, run, lock=False)
                    detail["refine_s"] = info.get("sam_s")
                pick, reason, record = pointer.choose(ladder, refined, click, answer, size)
            if pick is not None:                # name exactly the outline handed over: the check looks for it
                crop = pointer.describe_crop(view, pick["mask"], run)
                described, info = pointer.describe(server, crop, request, preset)
                detail["describe_s"] = info["answer_s"]
    kind = (answer or described or {}).get("kind", "remove")
    if pick is not None and described and kind == "remove" and (described.get("object") is False
                                                                  or pointer.surface(described)):
        reason, pick = f"the outline ({pick['name']}) holds only \"{described['item']}\"", None
    detail.update(pick=pick["name"] if pick else None, reason=reason)
    cands = public([c for c in ladder if c["name"] != "given"], size)
    if pick is None:
        return {"status": "not_found", "reason": reason, "answer": answer, "described": described, "outlines": record,
                "candidates": cands, "detail": detail}
    target, mask = pointer.target_from(pick, size, answer, described, refined)
    path = common.save_mask(mask, run / "mask.png")
    return {"status": "found", "reason": reason, "default": pick["name"], "answer": answer, "described": described,
            "outlines": record, "candidates": cands, "target": target, "mask": str(path),
            "cut_off": common.touches_edge(mask), "detail": detail}


def after_prepare(state):
    if state["mode"] == "point":
        return "highlight" if state.get("highlight") else "point"
    return state["mode"]


def after_point(state):
    if state["status"] != "found" or not state.get("cut_off") or not state.get("scan") or state.get("previous"):
        return "write"
    share = float(np.asarray(Image.open(state["mask"]).convert("L")).mean() / 255)
    return "recenter" if share <= RECENTER_MAX_SHARE else "write"


_KEEP = ("scan", "point", "view", "size", "work_dir", "status", "reason", "default", "answer", "described",
         "outlines", "candidates", "target", "mask", "cut_off")


@step("recenter")
def recenter(state, preset, say):
    mask = np.asarray(Image.open(state["mask"]).convert("L")) > 127
    scan, point = pointer.recenter(state["scan"], state["size"], mask, state["point"])
    work = Path(state["run_dir"]) / "recentred"
    work.mkdir()
    view, size = render(scan, preset, work)
    return {"previous": {k: state.get(k) for k in _KEEP}, "scan": scan, "point": point, "view": str(view),
            "size": list(size), "work_dir": str(work), "described": None,
            "detail": {"yaw": scan["yaw"], "pitch": scan["pitch"], "point": point}}


@step("write")
def write(state, preset, say):
    s, note = dict(state), None
    prev = state.get("previous")
    if prev and state.get("status") != "found" and prev.get("status") == "found":
        s.update(prev)                         # the centred view did worse: keep the first result
        note = "the centred view found nothing; kept the user's view"
    run = Path(state["run_dir"])
    answer = s.get("answer") or {}
    if s["status"] == "found":
        target = s["target"]
    else:
        target = {"item": answer.get("item", ""), "kind": answer.get("kind", "remove"),
                  "behind": answer.get("behind", ""), "instruction": answer.get("instruction", ""), "boxes": []}
    request = state.get("request") or (f"remove the {target['boxes'][0]['label']}" if target["boxes"]
                                       else "remove the thing at the click")
    source = {"scan": s["scan"]} if s.get("scan") else {"image": s["image"]}
    first = prev if prev else s
    record = {"mode": "point", "status": s["status"], "reason": s["reason"], "marker": state.get("marker") or "both",
              "click": first["point"], "chosen": s.get("default"), "candidates": s.get("candidates"),
              "outlines": s.get("outlines"), "vlm": answer or None, "described": s.get("described"),
              "cut_off": s.get("cut_off"),
              "recentred": {"from": prev["scan"], "to": state["scan"], "used": not note} if prev else None,
              "note": note, "run_dir": str(run), "timings": state.get("timings")}
    found = common.graph_input(request, source, target, s.get("mask") if s["status"] == "found" else None,
                               state.get("preset"), record)
    path = common.write_found(run, found)

    size = tuple(s["size"])
    mask = np.asarray(Image.open(s["mask"]).convert("L")) > 127 if s.get("mask") and s["status"] == "found" else None
    vlm_boxes = [steps.to_pixels(b["bbox_2d"], size) for b in answer.get("boxes", [])] if answer.get("found") else []
    final = steps.to_pixels(target["boxes"][0]["bbox_2d"], size) if target["boxes"] else None
    caption = (f"{s['status'].upper()} ({s['reason']}, outline {s.get('default')}): {target['item']}\n"
               f"instruction: {target['instruction']}\nbehind: {target['behind']}"
               + (f"\n{note}" if note else ""))
    sheet = common.sheet(s["view"], run / "sheet.jpg", mask, common.to_px(s["point"], size), vlm_boxes, final, caption)
    return {"found": found, "found_path": str(path), "status": s["status"], "reason": s["reason"],
            "candidates": s.get("candidates"), "default": s.get("default"), "sheet": str(sheet),
            "detail": {"status": s["status"]}}


def _searched(run, hit, tried, hits, found, nothing):
    """The state after a search: the view where the thing was found, its target and mask, and every
    candidate with its own mask so a UI can offer the others."""
    cands = []
    for i, f in enumerate(found):
        path = common.save_mask(f["mask_array"], run / f"candidate_{i}.png")
        cands.append({"scan": f["scan"], "item": f["target"]["item"], "labels": [b["label"] for b in f["target"]["boxes"]],
                      "share": round(float(f["mask_array"].mean()), 4), "mask": str(path), "reason": f["reason"]})
    detail = {"views_asked": len(tried), "hits": hits}
    if hit is None:
        return {"status": "not_found", "reason": nothing, "tried": tried, "hits": hits, "candidates": cands,
                "several": False, "detail": detail}
    several = len(found) > 1 or len(hit["target"]["boxes"]) > 1
    count = max(len(found), len(hit["target"]["boxes"]))
    reason = hit["reason"] + (f"; {count} things fit, ask the user" if several else "")
    path = common.save_mask(hit["mask_array"], run / "mask.png")
    return {"status": "found", "reason": reason, "scan": hit["scan"], "view": hit["view"], "size": hit["size"],
            "target": hit["target"], "mask": str(path), "tried": tried, "hits": hits, "candidates": cands,
            "several": several, "detail": {**detail, "pano": hit["scan"]["pano"], "yaw": hit["scan"]["yaw"]}}


@step("look")
def look(state, preset, say):
    run = Path(state["run_dir"])
    hit, tried, hits = search.look_around(state["scan"], state["request"], preset, run, say)
    return _searched(run, hit, tried, hits, [hit] if hit else [],
                     "not in this view, the other directions of this panorama or the nearest panoramas")


@step("search")
def search_scan(state, preset, say):
    run = Path(state["run_dir"])
    hit, tried, hits, found = search.search(state["scan"]["model"], state["request"], preset, run, say, state.get("near"))
    nothing = "the inventory names nothing that fits" if not hits else f"the inventory names {hits}, but locate found none"
    return _searched(run, hit, tried, hits, found, nothing)


@step("deliver")
def deliver(state, preset, say):
    run, ok = Path(state["run_dir"]), state["status"] == "found"
    target = state["target"] if ok else {"item": "", "kind": "remove", "behind": "", "instruction": "", "boxes": []}
    inventory = search.inventory_path(state["scan"]["model"])
    record = {"mode": state["mode"], "status": state["status"], "reason": state["reason"],
              "several": state.get("several"), "hits": state.get("hits"), "candidates": state.get("candidates"),
              "tried": state.get("tried"), "inventory": str(inventory) if inventory.exists() else None,
              "run_dir": str(run), "timings": state.get("timings")}
    found = common.graph_input(state["request"], {"scan": state["scan"]}, target, state.get("mask") if ok else None,
                               state.get("preset"), record)
    path = common.write_found(run, found)
    sheet = None
    if state.get("view"):
        size = tuple(state["size"])
        mask = np.asarray(Image.open(state["mask"]).convert("L")) > 127 if ok else None
        boxes = [steps.to_pixels(b["bbox_2d"], size) for b in target["boxes"]]
        sc = state["scan"]
        caption = (f"{state['status'].upper()} ({state['reason']}): {target['item']}\n"
                   f"view: pano {sc['pano']}, yaw {sc.get('yaw', 0)}, pitch {sc.get('pitch', 0)}; "
                   f"{len(state.get('tried') or [])} questions asked\n"
                   f"instruction: {target['instruction']}\nbehind: {target['behind']}")
        sheet = common.sheet(state["view"], run / "sheet.jpg", mask, None, boxes, None, caption)
    return {"found": found, "found_path": str(path), "status": state["status"], "reason": state["reason"],
            "candidates": state.get("candidates"), "several": state.get("several"),
            "sheet": str(sheet) if sheet else None, "detail": {"status": state["status"]}}


builder = StateGraph(FindState, input_schema=FindInput, output_schema=FindOutput)
for node in (prepare, highlight, point, recenter, write, look, search_scan, deliver):
    builder.add_node(node.__name__, node)
builder.add_edge(START, "prepare")
builder.add_conditional_edges("prepare", after_prepare, ["highlight", "point", "look", "search"])
builder.add_edge("look", "deliver")
builder.add_edge("search", "deliver")
builder.add_edge("deliver", END)
builder.add_edge("highlight", END)
builder.add_conditional_edges("point", after_point, ["recenter", "write"])
builder.add_edge("recenter", "point")
builder.add_edge("write", END)

graph = builder.compile(name="find_target")

"""The edit as a LangGraph graph: a first pass, then at most one repair.

  prepare -> locate -> segment -> [describe] -> generate -> paste -> measure -> inspect -> report -> END
                 |          |                                          ^                    |
                 |          |                                          +----- repair <------+  an issue the graph can fix itself
                 +----------+-- nothing found, or an empty mask ---------------------------> report

Input: a request and either an image path or a scan view. Output: the edited image and a report.

The same graph runs both kinds of edit, switched on `target.kind`. A `remove` uses the steps in this
folder. A `change` (a new countertop, floor or pillow colour) uses Mateo-Retexture-Agent's code in
change/: `describe` fills the change block from a close-up (change/spec.py), the prompt comes from
change/wording.py, the paste and the checks from change/paste.py and change/checks.py. Both kinds
end in the same report (report.py): issues at `report_severity` and above, the rest as notes.

measure also scouts: it marks places outside the item where the edit removed or added edges
(scout.py). inspect asks the VLM what is inside each place, before and after. Three kinds of issue
carry an `action`, which repair carries out before measure, inspect and report run again:
- `regenerate`: the edit failed outright (another picture, nothing changed, the colour did not land),
  so there is nothing to mend. The image model draws again with the next seed, for either kind. A redraw
  stands in for the first pass (`max_redraws`), so the picture it makes can still get one repair below.
- `remove_again`: the VLM still sees something that was to go (named in the close-up, left floating,
  or named at a scouted place). It is found by name in the result and removed from it (about 40 s).
- `restore`: trim that was there is gone (a baseboard went with a lamp). The original's detail is put back.
If the repair made the report worse, the first result is kept. Issues without an `action` are reported only.

If the input already has a `target` (the thing was found by a click or a search), locate is skipped.
If it also has a `mask`, segment is skipped too. With a `raw` as well (an image-model picture made
earlier), generate is skipped: that replays a finished run from its paste, without the image model.

Each node sends progress on the "custom" stream (step, status, seconds), so a client can follow a run.
"""
import json
import operator
import re
import shutil
import time
from dataclasses import replace
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from typing import Annotated, TypedDict

import numpy as np
from langgraph.config import get_stream_writer
from langgraph.graph import END, START, StateGraph
from PIL import Image

from edit_agent import gpu, metrics, report, scout, steps
from edit_agent.change import checks as change_checks
from edit_agent.change import paste as change_paste
from edit_agent.change.spec import describe as describe_change
from edit_agent.config import DEFAULT_PRESET, PRESETS, RUNS
from edit_agent.schemas import edit_prompt, head, parts, read_request, taken
from lift import grow

CARRIED_REACH = 0.02      # share of the view a carried outline is grown by before a leftover must lie inside it


class EditInput(TypedDict, total=False):
    request: str            # what to change, in plain words
    image: str              # path to a picture on this PC, or
    scan: dict              # {"model": id, "pano": index, "yaw": deg, "pitch": deg, "fov": deg}
    preset: str             # a name from config.PRESETS
    name: str               # optional label for the run folder
    # When the thing was already found (a click, a search of the scan), hand it in and skip steps:
    target: dict            # skips locate: {item, kind, behind, instruction, boxes: [{label, bbox_2d}]}
    mask: str               # with target, skips segment: path to a mask image, white = the item
    raw: str                # with target and mask, skips generate: path to the image model's picture
    # Set by the all_views graph (panos.py) for each view it hands over; never from a network request:
    run_dir: str            # the folder for this view's files, instead of a new one under RUNS
    refs: list              # for a change: pictures the image model also gets (the first view's result, redrawn here)
    note: str               # for a change with refs: the words added to the prompt that say what the refs are
    carried: bool           # the target and mask were carried from another view through the mesh, so what goes is
                            # settled: a leftover must lie inside the given outline, and nothing is looked for elsewhere


class EditState(EditInput, total=False):
    view: str
    edited: str
    paste_mask: str
    regions: list           # places the scout marked for a closer look
    findings: dict
    scores: Annotated[dict, operator.or_]
    timings: Annotated[dict, operator.or_]
    report: dict
    sheet: str
    passes: int             # repairs done so far
    before_repair: dict     # {edited, report} a repair started from; kept if the repair made things worse
    repairs: Annotated[list, operator.add]
    cleared: dict           # {what, why}: leftovers a second look found to be separate things; the report notes them
    raw_from: str           # the picture the latest raw was drawn from, when not the view (a second removal's)


def step(name):
    """Wrap a node: announce it on the custom stream and record how long it took."""
    def wrap(fn):
        def node(state):
            say = get_stream_writer()
            label = f"{name}_{state['passes'] + 1}" if state.get("passes") else name      # measure_2 after a repair
            say({"step": label, "status": "started"})
            t0 = time.time()
            out = fn(state, PRESETS[state.get("preset") or DEFAULT_PRESET])
            timing = {"seconds": round(time.time() - t0, 1), **out.pop("detail", {})}
            say({"step": label, "status": "done", **timing})
            return {**out, "timings": {label: timing}}
        node.__name__ = name
        return node
    return wrap


@step("prepare")
def prepare(state, preset):
    if state.get("run_dir"):
        run = Path(state["run_dir"])
        run.mkdir(parents=True, exist_ok=True)
    else:
        # Cleaned whichever it comes from: the name reaches a folder name, and a request may come off the network.
        label = re.sub(r"[^a-z0-9]+", "-", (state.get("name") or state["request"]).lower()).strip("-")[:40] or "edit"
        run = RUNS / f"{datetime.now():%Y%m%d-%H%M%S}-{label}"
        run.mkdir(parents=True)
    view, size = steps.prepare(state.get("image"), state.get("scan"), preset, run)
    out = {"run_dir": str(run), "view": str(view), "detail": {"size": list(size)}}
    if state.get("raw") and not (state.get("target") and state.get("mask")):
        raise ValueError("a `raw` needs a `target` and a `mask`: the paste works from both")
    if state.get("target"):
        out["target"] = steps.adopt(state["target"], view)
        out["detail"]["given"] = ["target"]
        if state.get("mask"):
            out["mask"] = str(steps.adopt_mask(state["mask"], view, preset, run))
            out["detail"]["given"].append("mask")
        if state.get("raw"):
            out["raw"] = str(shutil.copy(state["raw"], run / "raw.png"))
            out["detail"]["given"].append("raw")
    elif state.get("mask"):
        raise ValueError("a `mask` needs a `target`: the image model works from the target's words")
    return out


def _changing(state):
    return state["target"]["kind"] == "change"


def _to_draw(state):
    """After the mask: a change without its change block is described first; then the image model, or the
    paste when a raw was handed in."""
    if _changing(state) and not state["target"].get("change"):
        return "describe"
    return "paste" if state.get("raw") else "generate"


def after_prepare(state):
    if not state.get("target"):
        return "locate"
    if not state["target"]["boxes"]:
        return "report"
    if not state.get("mask"):
        return "segment"
    return _to_draw(state)


@step("locate")
def locate(state, preset):
    with gpu.vlm(preset, log=Path(state["run_dir"]) / "llama-server.log") as server:
        target, info = steps.locate(server, state["view"], state["request"], preset)
        info["vlm_load_s"] = server.load_s
    return {"target": target, "detail": info}


@step("segment")
def segment(state, preset):
    with gpu.exclusive():
        mask, info = steps.segment(state["view"], state["target"]["boxes"], preset, Path(state["run_dir"]))
    return {"mask": str(mask) if mask else "", "detail": info}


@step("describe")
def describe(state, preset):
    """For a change: the change block {style, from, to, keep, form} from one VLM question on a close-up of the
    thing (change/spec.py, Mateo-Retexture-Agent's), unless the target came with one. The image model's prompt
    is then built from the block alone (change/wording.py)."""
    run = Path(state["run_dir"])
    ys, xs = np.nonzero(np.asarray(Image.open(state["mask"]).convert("L")) > 127)
    box = [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1]
    crop, _ = change_checks.close_up(state["view"], box, run, margin=0.4, tag="describe_crop")
    target = dict(state["target"])
    with gpu.vlm(preset, log=run / "llama-server.log") as server:
        target["change"], info = describe_change(server, preset, crop, state["request"], target)
        info["vlm_load_s"] = server.load_s
    target["prompt"] = steps.change_prompt(target)
    return {"target": target, "detail": {**info, "change": target["change"]}}


def _paste(target, view, raw, mask, preset, run):
    """A removal pastes a grown area with the shadow (steps.paste). A change pastes inside the thing only, and
    a recolour only its named colour (change/paste.py); with `form: small` the area also takes the new outline
    SAM finds in the image model's picture. Same return shape either way."""
    if target["kind"] != "change":
        return steps.paste(view, raw, mask, preset, run)
    outline, form = None, {}
    if target["change"]["form"] == "small":
        outline, form = change_paste.new_outline(raw, np.asarray(Image.open(mask).convert("L")) > 127, run)
    edited, area, info = change_paste.paste(view, raw, mask, target, preset, run, outline)
    return edited, area, {**info, **{k: form[k] for k in ("form_iou", "form_beyond", "form_box") if k in form}}


def _draw(state, preset, run):
    """The image model, under the GPU lock. With `refs` (another view's result, for a change) it is
    Mateo-Retexture-Agent's runner, which takes extra pictures and the note that says what they are."""
    with gpu.exclusive():
        if state.get("refs"):
            from edit_agent.change.generate import generate as with_refs
            return with_refs(state["view"], state["target"]["prompt"] + (state.get("note") or ""), preset, run,
                             refs=state["refs"], tag="raw")
        return steps.generate(state["view"], state["target"]["prompt"], preset, run)


@step("generate")
def generate(state, preset):
    raw, info = _draw(state, preset, Path(state["run_dir"]))
    return {"raw": str(raw), "detail": info}


@step("paste")
def paste(state, preset):
    edited, area, info = _paste(state["target"], state["view"], state["raw"], state["mask"], preset,
                                Path(state["run_dir"]))
    return {"edited": str(edited), "paste_mask": str(area), "scores": info}


@step("measure")
def measure(state, preset):
    """The numbers for the report, then the scout. A change is measured by change/checks.py: did the colour
    land, does the light on the thing still follow the photo's, did the outline move. The paste's own
    numbers (the old colour's hue, the new outline) are in the scores already."""
    run = Path(state["run_dir"])
    if _changing(state):
        given = state.get("scores") or {}
        form = {k: given[k] for k in ("form_iou", "form_beyond", "form_box") if k in given} or None
        scores = change_checks.measure(state["view"], state["raw"], state["edited"], state["mask"], state["paste_mask"],
                                       state["target"], preset, run, form, given)
    else:
        scores = metrics.measure(state["view"], state["raw"], state["edited"], state["mask"], state["paste_mask"],
                                 run / "effect.png", state.get("raw_from"))
    regions = scout.find(*scout.read(state["view"], state["edited"], state["mask"], state["paste_mask"]), preset.limits)
    return {"scores": scores, "regions": regions, "detail": {"places": len(regions)}}


@step("inspect")
def inspect(state, preset):
    """The VLM's questions. A change gets change/checks.py's: one close-up per changed part, outlined, asking
    whether it is the new colour or material and whether any old colour is left. Both kinds then get the
    scout's places, if it marked any."""
    run = Path(state["run_dir"])
    with gpu.vlm(preset, log=run / "llama-server.log") as server:
        if _changing(state):
            findings, info = change_checks.inspect(server, preset, state["edited"], state["target"],
                                                   state["paste_mask"], run)
            info = dict(info)
            if state.get("regions"):
                findings["places"], info["places_s"] = steps.places(server, state["view"], state["edited"],
                                                                    state["regions"], state["target"]["item"],
                                                                    preset, run, state.get("mask"))
        else:
            findings, info = steps.inspect(server, state["view"], state["edited"], state["request"], state["target"],
                                           preset, run, also=state["scores"].get("effect_box"),
                                           regions=state.get("regions"), mask=state.get("mask"))
        info["vlm_load_s"] = server.load_s
    return {"findings": findings, "detail": info}


@step("report")
def write_report(state, preset):
    run = Path(state["run_dir"])
    result = report.build(state, preset.limits).model_dump()
    out, earlier = {}, state.get("before_repair")
    if earlier:
        if report.weight(result) > report.weight(earlier["report"]):          # the repair made it worse
            result = {**earlier["report"], "summary": earlier["report"]["summary"]
                      + " A repair was tried and made the report worse, so the first result is kept."}
            out["edited"] = earlier["edited"]
        else:
            before = earlier["report"]["summary"].split(" After a repair")[0]    # the pass just before, not nested
            result["summary"] += f" After a repair; the pass before had: {before}"
    record = {key: state.get(key) for key in ("request", "preset", "image", "scan", "view", "mask", "raw", "edited",
                                              "paste_mask", "target", "regions", "findings", "timings", "repairs",
                                              "cleared")}
    record.update(out)
    (run / "report.json").write_text(json.dumps({**record, "report": result}, indent=2), encoding="utf-8")
    return {**out, "report": result, "sheet": str(report.sheet({**state, **out}, result, run / "sheet.jpg"))}


def after_report(state):
    """Go round once more only if the report names something the graph can repair by itself.

    A redraw (an edit that failed outright, drawn again with a new seed) stands in for the first pass, as the
    retexture command line's new seeds do, so it does not use up the repair: a redrawn picture with a leftover
    still gets it removed. A picture that still failed outright after its redraws gets nothing more."""
    preset = PRESETS[state.get("preset") or DEFAULT_PRESET]
    issues = state["report"]["issues"]
    done = state.get("repairs") or []
    redraws = sum(r["action"] == "regenerate" for r in done)
    repaired = state.get("passes", 0) - redraws          # every visit to repair counts, even one that found nothing
    if any(i.get("action") == "regenerate" for i in issues):
        return "repair" if redraws < preset.max_redraws else END
    fixable = any(i.get("action") for i in issues)
    return "repair" if fixable and repaired < preset.max_repairs else END


def _inside(box, area):
    """The share of a pixel box that lies inside a boolean area."""
    x0, y0, x1, y1 = box
    part = area[y0:y1, x0:x1]
    return float(part.mean()) if part.size else 0.0


def remove_again(state, preset, n, left, missed=(), added=()):
    """A second removal of what the first one left (`left`: names the VLM gave), done on the first result.

    The locator finds the names in the result. Each box it finds is a thing the first locator never found
    (`missed`, from the request's own words: its noun is one of those names) or a leftover. A leftover must
    lie mostly inside the first paste area: a look-alike elsewhere stays. Then:
    - If the request names a place things stand on ("on the dresser"), the box is taken only if it stands
      on that place or floats (BELONG_PROMPT, asked on the first result, where the box was found). On the
      result a plant pot whose base the removed vase hid is seen on the floor, and a lamp shade whose base
      went is seen floating.
    - Otherwise a missed thing is taken, and a leftover is taken unless, on the original with the first
      outline in green, it is a separate thing (OWN_PROMPT): the VLM has called a stool beside a
      nightstand the vase that was removed.
    In a view carried from another one (`carried`, set by all_views), the mesh has already said where every
    removed thing is, so nothing counts as missed, and a box must lie mostly inside the carried outline
    (grown by CARRIED_REACH of the view). The VLM read the yellow blanket under the bed's tray as "a yellow
    throw pillow" left behind, and the paste area, which takes in most of the bed, did not keep it.
    A thing the image model drew (`added`, names from `object_added`) was never in the original, so the
    outline does not hold it: it is taken where it lies mostly inside the paste area, in any view, and
    one outside it was not drawn by this edit. When every name is an added one, every box found is one.
    Its files go to pass<n>/; the masks are joined with the first pass's so that the check sees both.
    """
    run = Path(state["run_dir"])
    sub = run / f"pass{n + 1}"
    sub.mkdir(exist_ok=True)
    request = "remove the " + " and the ".join(left)
    req = read_request(state["request"])
    carried = bool(state.get("carried"))
    missed_heads = set() if carried else {head(p) for name in missed for p in parts(name)}   # "the vases and the tray on the bed"
    added_heads = {head(p) for name in added for p in parts(name)}
    all_added = bool(added) and set(left) <= set(added)       # the VLM's "box, plate" may be the locator's "tray"
    on = {head(p) for b in state["target"]["boxes"] for p in parts(b["label"])}   # what the first pass took
    pasted = np.asarray(Image.open(state["paste_mask"]).convert("L")) > 127
    outline = np.asarray(Image.open(state["mask"]).convert("L")) > 127
    if carried:
        outline = grow(outline, round(CARRIED_REACH * max(outline.shape)))
    boxes, judged = [], []
    with gpu.vlm(preset, log=sub / "llama-server.log") as server:
        target, _ = steps.locate(server, state["edited"], request, preset)
        for i, b in enumerate(target["boxes"]):
            way = "missed" if head(b["label"]) in missed_heads else "left"
            if all_added or head(b["label"]) in added_heads:
                way = "added"
            said = {}
            if way == "added" and _inside(b["box"], pasted) < 0.5:
                way = "not drawn by the edit: outside the paste area"
            elif carried and way != "added" and _inside(b["box"], outline) < 0.5:
                way = "outside the outline carried from the first view"
            elif way == "left" and _inside(b["box"], pasted) < 0.5:
                way = "outside the first paste"
            elif req["prep"] == "on":
                said, _ = steps.belongs(server, preset, state["edited"], b["box"], req["anchor"], sub / f"belong{i}.png")
                if not taken(said, req, on):
                    way = f"not on {req['anchor']}: {said['belongs']}, on {said['under']}"
            elif way == "left":
                said, _ = steps.own(server, preset, state["view"], b["box"], state["mask"], state["target"]["item"],
                                    sub / f"own{i}.png")
                if said["belongs"] == "separate":
                    way = f"separate: {said['red']}"
            judged.append({"label": b["label"], "way": way, **said})
            if way in ("missed", "left", "added"):
                boxes.append(b)
    if not boxes:
        return None, {"request": request, "judged": judged, "taken": []}
    target["boxes"] = boxes
    # The image model is told to remove only what was taken. With the locator's own instruction it was told
    # "remove the yellow textured throw pillow, dark grey tray, cup, box" after the "pillow" (the bed's
    # yellow blanket) had been refused, removed the blanket under the tray, and the shadow-following paste
    # carried that change in as part of the tray's effect.
    names = list(dict.fromkeys(b["label"] for b in boxes))
    target["instruction"] = "Remove the " + " and the ".join(names) + "."
    target["prompt"] = edit_prompt(SimpleNamespace(instruction=target["instruction"], kind="remove"))
    with gpu.exclusive():
        mask, _ = steps.segment(state["edited"], boxes, preset, sub)
        if not mask:
            return None, {"request": request, "taken": [b["label"] for b in boxes], "mask": "empty"}
        # What was left is a part of what was removed, so never larger. When the VLM called a kept coffee
        # table's top "a tray", the second cut-out took the whole table, twice the first one (a vase left
        # floating measured 0.16 of the first). A missed thing can be any size, so then this does not apply.
        first = (np.asarray(Image.open(state["mask"]).convert("L")) > 127).sum()
        second = (np.asarray(Image.open(mask).convert("L")) > 127).sum()
        if second > first and not any(j["way"] in ("missed", "added") for j in judged):
            return None, {"request": request, "judged": judged, "taken": [],
                          "refused": f"the second outline is {second / first:.1f} times the first, so it is not a leftover"}
        raw, _ = steps.generate(state["edited"], target["prompt"], preset, sub)
    edited, area, _ = steps.paste(state["edited"], raw, mask, preset, sub)
    joined = {}
    for key, new in (("mask", mask), ("paste_mask", area)):
        both = (np.asarray(Image.open(state[key]).convert("L")) > 127) | (np.asarray(Image.open(new).convert("L")) > 127)
        joined[key] = str(run / f"{key}_{n + 1}.png")
        Image.fromarray(both.astype(np.uint8) * 255).save(joined[key])
    merged = {**state["target"], "boxes": state["target"]["boxes"] + boxes,
              "item": f"{state['target']['item']}; also {', '.join(b['label'] for b in boxes)}"}
    return ({"edited": str(edited), "raw": str(raw), "raw_from": state["edited"], "target": merged, **joined},
            {"request": request, "judged": judged, "taken": [b["label"] for b in boxes]})


def regenerate(state, preset, n):
    """The image model again from the view, with a new seed, then the same paste. Mateo-Retexture-Agent's
    first view does this when its result has a severity-3 issue (change/__main__.one, `retries`), and the
    report then keeps the less bad of the two. Here it is the second pass for both kinds of edit, for an
    edit that failed outright: the model returned another picture, or the change did not land."""
    sub = Path(state["run_dir"]) / f"pass{n + 1}"
    sub.mkdir(exist_ok=True)
    seed = preset.seed + n
    raw, _ = _draw(state, replace(preset, seed=seed), sub)
    edited, area, info = _paste(state["target"], state["view"], raw, state["mask"], preset, sub)
    return {"edited": str(edited), "raw": str(raw), "paste_mask": str(area), "raw_from": "", "scores": info}, seed


@step("repair")
def repair(state, preset):
    """Act on the issues that carry an `action`. An edit that failed outright is drawn again with a new seed,
    and nothing else is tried on it. Otherwise: remove again what the VLM saw left, then restore lost trim."""
    run = Path(state["run_dir"])
    n = state.get("passes", 0) + 1
    for name in ("report.json", "sheet.jpg"):                                 # keep the first pass's record
        src = run / name
        shutil.copy(src, src.with_name(f"{src.stem}_{n}{src.suffix}"))
    issues = state["report"]["issues"]
    out = {"passes": n, "before_repair": {"edited": state["edited"], "report": state["report"]}}
    failed = [i["kind"] for i in issues if i.get("action") == "regenerate"]
    if failed:
        again, seed = regenerate(state, preset, n)
        done = [{"pass": n + 1, "action": "regenerate", "seed": seed, "why": failed}]
        return {**out, **again, "repairs": done, "detail": {"regenerate": seed}}
    done, detail, current = [], {}, state
    again_ = [i for i in issues if i.get("action") == "remove_again" and i.get("what")]
    missed = [i["what"] for i in again_ if i.get("missed")]
    added = [i["what"] for i in again_ if i["kind"] == "object_added"]
    # the missed names carry their place ("tray on the bed"), so they go last: the request is read up to its first "on"
    left = list(dict.fromkeys([i["what"] for i in again_ if not i.get("missed")] + missed))
    if left:
        again, detail["remove_again"] = remove_again(state, preset, n, left, missed, added)
        if again:
            out.update(again)
            current = {**state, **again}
            done.append({"pass": n + 1, "action": "remove_again", "what": left, **detail["remove_again"]})
        else:
            # Found by name and every box judged a separate thing (the plant pot "on wooden floor"): the
            # leftover was a false alarm, so the next report notes it instead of failing on it again.
            judged = detail["remove_again"].get("judged") or []
            if judged and all(j["way"].startswith(("not on", "separate", "outside the outline", "not drawn"))
                              for j in judged):
                out["cleared"] = {"what": left, "why": "; ".join(f"{j['label']}: {j['way']}" for j in judged)}
    boxes = [i["region"] for i in issues if i.get("action") == "restore"]
    if boxes:
        out["edited"] = str(steps.restore(state["view"], current["edited"], current["mask"], boxes,
                                          run / f"edited_{n + 1}.png", preset.limits))
        done.append({"pass": n + 1, "action": "restore", "boxes": boxes})
        detail["restored"] = len(boxes)
    out.setdefault("edited", state["edited"])
    return {**out, "repairs": done, "detail": detail}


builder = StateGraph(EditState, input_schema=EditInput)
for node in (prepare, locate, segment, describe, generate, paste, measure, inspect, write_report, repair):
    builder.add_node(node.__name__, node)
builder.add_edge(START, "prepare")
builder.add_conditional_edges("prepare", after_prepare, ["locate", "segment", "describe", "generate", "paste", "report"])
builder.add_conditional_edges("locate", lambda s: "segment" if s["target"]["boxes"] else "report",
                              ["segment", "report"])
builder.add_conditional_edges("segment", lambda s: _to_draw(s) if s["mask"] else "report",
                              ["describe", "generate", "paste", "report"])
builder.add_conditional_edges("describe", lambda s: "paste" if s.get("raw") else "generate", ["generate", "paste"])
builder.add_edge("generate", "paste")
builder.add_edge("paste", "measure")
builder.add_edge("measure", "inspect")
builder.add_edge("inspect", "report")
builder.add_conditional_edges("report", after_report, ["repair", END])
builder.add_edge("repair", "measure")

graph = builder.compile(name="first_pass")

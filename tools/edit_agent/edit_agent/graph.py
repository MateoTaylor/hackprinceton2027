"""The edit as a LangGraph graph: a first pass, then at most one repair.

  prepare -> locate -> segment -> generate -> paste -> measure -> inspect -> report -> END
                 |          |                             ^                    |
                 |          |                             +----- repair <------+  an issue the graph can fix itself
                 +----------+-- nothing found, or an empty mask --------------> report

Input: a request and either an image path or a scan view. Output: the edited image and a report.

measure also scouts: it marks places outside the item where the edit removed or added edges
(scout.py). inspect asks the VLM what is inside each place, before and after. If trim that was there
is gone (a baseboard went with a lamp), report gives the issue an `action`, repair puts the original's
detail back there, and measure, inspect and report run again. If the repair made the report worse,
the first result is kept. Issues without an `action` are reported and not repaired.

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
from datetime import datetime
from pathlib import Path
from typing import Annotated, TypedDict

from langgraph.config import get_stream_writer
from langgraph.graph import END, START, StateGraph

from edit_agent import gpu, metrics, report, scout, steps
from edit_agent.config import DEFAULT_PRESET, PRESETS, RUNS


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


class EditState(EditInput, total=False):
    run_dir: str
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
    label = state.get("name") or re.sub(r"[^a-z0-9]+", "-", state["request"].lower()).strip("-")[:40]
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


def after_prepare(state):
    if not state.get("target"):
        return "locate"
    if not state["target"]["boxes"]:
        return "report"
    if not state.get("mask"):
        return "segment"
    return "paste" if state.get("raw") else "generate"


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


@step("generate")
def generate(state, preset):
    with gpu.exclusive():
        raw, info = steps.generate(state["view"], state["target"]["prompt"], preset, Path(state["run_dir"]))
    return {"raw": str(raw), "detail": info}


@step("paste")
def paste(state, preset):
    edited, area, info = steps.paste(state["view"], state["raw"], state["mask"], preset, Path(state["run_dir"]))
    return {"edited": str(edited), "paste_mask": str(area), "scores": info}


@step("measure")
def measure(state, preset):
    scores = metrics.measure(state["view"], state["raw"], state["edited"], state["mask"], state["paste_mask"],
                             Path(state["run_dir"]) / "effect.png")
    regions = scout.find(*scout.read(state["view"], state["edited"], state["mask"], state["paste_mask"]), preset.limits)
    return {"scores": scores, "regions": regions, "detail": {"places": len(regions)}}


@step("inspect")
def inspect(state, preset):
    with gpu.vlm(preset, log=Path(state["run_dir"]) / "llama-server.log") as server:
        findings, info = steps.inspect(server, state["view"], state["edited"], state["request"], state["target"],
                                       preset, Path(state["run_dir"]), also=state["scores"].get("effect_box"),
                                       regions=state.get("regions"))
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
            result["summary"] += f" After a repair; the first pass had: {earlier['report']['summary']}"
    record = {key: state.get(key) for key in ("request", "preset", "image", "scan", "view", "mask", "raw", "edited",
                                              "target", "regions", "findings", "timings", "repairs")}
    record.update(out)
    (run / "report.json").write_text(json.dumps({**record, "report": result}, indent=2), encoding="utf-8")
    return {**out, "report": result, "sheet": str(report.sheet({**state, **out}, result, run / "sheet.jpg"))}


def after_report(state):
    """Go round once more only if the report names something the graph can repair by itself."""
    preset = PRESETS[state.get("preset") or DEFAULT_PRESET]
    fixable = any(i.get("action") for i in state["report"]["issues"])
    return "repair" if fixable and state.get("passes", 0) < preset.max_repairs else END


@step("repair")
def repair(state, preset):
    """Act on the issues that carry an `action`. So far there is one: restore removed trim at a scouted place."""
    run = Path(state["run_dir"])
    n = state.get("passes", 0) + 1
    for name in ("report.json", "sheet.jpg"):                                 # keep the first pass's record
        src = run / name
        shutil.copy(src, src.with_name(f"{src.stem}_{n}{src.suffix}"))
    boxes = [i["region"] for i in state["report"]["issues"] if i.get("action") == "restore"]
    edited = steps.restore(state["view"], state["edited"], state["mask"], boxes, run / f"edited_{n + 1}.png",
                           preset.limits)
    return {"edited": str(edited), "passes": n, "before_repair": {"edited": state["edited"], "report": state["report"]},
            "repairs": [{"pass": n + 1, "action": "restore", "boxes": boxes}], "detail": {"restored": len(boxes)}}


builder = StateGraph(EditState, input_schema=EditInput)
for node in (prepare, locate, segment, generate, paste, measure, inspect, write_report, repair):
    builder.add_node(node.__name__, node)
builder.add_edge(START, "prepare")
builder.add_conditional_edges("prepare", after_prepare, ["locate", "segment", "generate", "paste", "report"])
builder.add_conditional_edges("locate", lambda s: "segment" if s["target"]["boxes"] else "report",
                              ["segment", "report"])
builder.add_conditional_edges("segment", lambda s: "generate" if s["mask"] else "report", ["generate", "report"])
builder.add_edge("generate", "paste")
builder.add_edge("paste", "measure")
builder.add_edge("measure", "inspect")
builder.add_edge("inspect", "report")
builder.add_conditional_edges("report", after_report, ["repair", END])
builder.add_edge("repair", "measure")

graph = builder.compile(name="first_pass")

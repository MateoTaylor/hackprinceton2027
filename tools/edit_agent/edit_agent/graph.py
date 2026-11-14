"""The first pass as a LangGraph graph.

  prepare -> locate -> segment -> generate -> paste -> measure -> inspect -> report
                 |          |                                                  ^
                 +----------+-- nothing found, or an empty mask ---------------+

Input: a request and either an image path or a scan view. Output: the edited image and a report
whose issues are what a second pass should fix. No second pass runs here.

If the input already has a `target` (the thing was found by a click or a search), locate is skipped.
If it also has a `mask`, segment is skipped too.

Each node sends progress on the "custom" stream (step, status, seconds), so a client can follow a run.
"""
import json
import operator
import re
import time
from datetime import datetime
from pathlib import Path
from typing import Annotated, TypedDict

from langgraph.config import get_stream_writer
from langgraph.graph import END, START, StateGraph

from edit_agent import gpu, metrics, report, steps
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


class EditState(EditInput, total=False):
    run_dir: str
    view: str
    raw: str
    edited: str
    paste_mask: str
    findings: dict
    scores: Annotated[dict, operator.or_]
    timings: Annotated[dict, operator.or_]
    report: dict
    sheet: str


def step(name):
    """Wrap a node: announce it on the custom stream and record how long it took."""
    def wrap(fn):
        def node(state):
            say = get_stream_writer()
            say({"step": name, "status": "started"})
            t0 = time.time()
            out = fn(state, PRESETS[state.get("preset") or DEFAULT_PRESET])
            timing = {"seconds": round(time.time() - t0, 1), **out.pop("detail", {})}
            say({"step": name, "status": "done", **timing})
            return {**out, "timings": {name: timing}}
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
    if state.get("target"):
        out["target"] = steps.adopt(state["target"], view)
        out["detail"]["given"] = ["target"]
        if state.get("mask"):
            out["mask"] = str(steps.adopt_mask(state["mask"], view, preset, run))
            out["detail"]["given"].append("mask")
    elif state.get("mask"):
        raise ValueError("a `mask` needs a `target`: the image model works from the target's words")
    return out


def after_prepare(state):
    if not state.get("target"):
        return "locate"
    if not state["target"]["boxes"]:
        return "report"
    return "generate" if state.get("mask") else "segment"


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
    return {"scores": metrics.measure(state["view"], state["raw"], state["edited"], state["mask"],
                                      state["paste_mask"], Path(state["run_dir"]) / "effect.png")}


@step("inspect")
def inspect(state, preset):
    with gpu.vlm(preset, log=Path(state["run_dir"]) / "llama-server.log") as server:
        findings, info = steps.inspect(server, state["view"], state["edited"], state["request"], state["target"],
                                       preset, Path(state["run_dir"]), also=state["scores"].get("effect_box"))
        info["vlm_load_s"] = server.load_s
    return {"findings": findings, "detail": info}


@step("report")
def write_report(state, preset):
    run = Path(state["run_dir"])
    result = report.build(state, preset.limits).model_dump()
    record = {key: state.get(key) for key in ("request", "preset", "image", "scan", "view", "mask", "raw", "edited",
                                              "target", "findings", "timings")}
    (run / "report.json").write_text(json.dumps({**record, "report": result}, indent=2), encoding="utf-8")
    return {"report": result, "sheet": str(report.sheet(state, result, run / "sheet.jpg"))}


builder = StateGraph(EditState, input_schema=EditInput)
for node in (prepare, locate, segment, generate, paste, measure, inspect, write_report):
    builder.add_node(node.__name__, node)
builder.add_edge(START, "prepare")
builder.add_conditional_edges("prepare", after_prepare, ["locate", "segment", "generate", "report"])
builder.add_conditional_edges("locate", lambda s: "segment" if s["target"]["boxes"] else "report",
                              ["segment", "report"])
builder.add_conditional_edges("segment", lambda s: "generate" if s["mask"] else "report", ["generate", "report"])
builder.add_edge("generate", "paste")
builder.add_edge("paste", "measure")
builder.add_edge("measure", "inspect")
builder.add_edge("inspect", "report")
builder.add_edge("report", END)

graph = builder.compile(name="first_pass")

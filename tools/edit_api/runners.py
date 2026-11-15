"""What runs an edit. Both runners return the same shape, which `jobs.py` turns into the contract:

    {"views": [{"pano": index, "yaw", "pitch", "fov", "view": Path, "edited": Path,
                "paste_mask": Path, "report": {verdict, issues, notes, summary}}, ...],
     "report": {verdict, issues, notes, summary}, "stub": bool, "note": str}

The first view is the starting panorama's. Paths are files on this PC; they never leave this module
except as pixels.

- StubRunner (Phase 1) builds that from finished runs in data/edit_agent/runs/. No GPU, no model.
- GraphRunner (Phase 2) will call the edit graph on 127.0.0.1:2025 once Mateo-Agent sends GO.
"""
from __future__ import annotations

import json
import re
import time
from collections import defaultdict
from pathlib import Path

from config import DATA

import faces

RUNS = DATA / "edit_agent" / "runs"
STEPS = ("prepare", "locate", "segment", "generate", "paste", "measure", "inspect", "report")
_WORD = re.compile(r"[a-z]+")
_STOP = {"the", "a", "an", "of", "from", "on", "in", "and", "to", "with", "make", "remove", "all", "it",
         "everything", "off", "this", "that", "please"}


def _words(text: str) -> set[str]:
    return {w.rstrip("s") for w in _WORD.findall((text or "").lower()) if w not in _STOP and len(w) > 2}


def short_report(rep: dict) -> dict:
    r = rep.get("report") or {}
    return {"verdict": r.get("verdict"), "issues": r.get("issues") or [], "notes": r.get("notes") or [],
            "summary": r.get("summary") or ""}


def overall(views: list[dict]) -> dict:
    issues, notes = [], []
    for v in views:
        issues += [{**i, "pano": v["pano"]} for i in v["report"]["issues"]]
        notes += [{**n, "pano": v["pano"]} if isinstance(n, dict) else {"pano": v["pano"], "text": n}
                  for n in v["report"]["notes"]]
    verdict = "pass" if views and all(v["report"]["verdict"] == "pass" for v in views) else "fix"
    summary = " ".join(f"Panorama {v['pano']}: {v['report']['summary']}" for v in views if v["report"]["summary"])
    return {"verdict": verdict, "issues": issues, "notes": notes, "summary": summary}


class StubRunner:
    """Picks the finished case that best fits the command, the scan and the starting panorama.

    Runs are grouped by case: `20261114-204338-ab-suite-clutter-bed-p6` is case
    `ab-suite-clutter-bed` seen from panorama 6. The newest run per panorama is used.
    """

    name = "stub"

    def cases(self, model_id: str) -> dict[str, dict[int, dict]]:
        groups: dict[str, dict[int, dict]] = defaultdict(dict)
        for run_dir in sorted(RUNS.glob("*")):           # names start with the time, so newest last
            p = faces.run_paths(run_dir)
            if not p or p["scan"].get("model") != model_id:
                continue
            case = re.sub(r"-p\d+$", "", run_dir.name.split("-", 2)[-1])
            groups[case][int(p["scan"]["pano"])] = {**p, "name": run_dir.name}
        return groups

    def pick(self, model_id: str, start: int, command: str) -> tuple[str, dict[int, dict]]:
        groups = self.cases(model_id)
        if not groups:
            return "", {}
        want = _words(command)

        def score(item):
            case, views = item
            asked = max(len(want & _words(v["report"].get("request", ""))) for v in views.values())
            return (asked, start in views, len(views), max(v["name"] for v in views.values()))
        return max(groups.items(), key=score)

    def run(self, job: dict, emit) -> dict:
        model_id, start = job["model_id"], job["start"]["index"]
        case, views = self.pick(model_id, start, job["command"])
        if not views:
            raise RuntimeError("no finished run of this scan to build a stub result from")
        order = sorted(views, key=lambda i: (i != start, i))
        out = []
        for k, i in enumerate(order):
            p = views[i]
            timings = p["report"].get("timings") or {}
            for step in STEPS:
                emit({"step": step, "status": "started", "pano": i, "view": k})
                time.sleep(0.15)
                sec = timings.get(step)
                sec = sec.get("seconds") if isinstance(sec, dict) else sec
                emit({"step": step, "status": "done", "pano": i, "view": k,
                      "seconds": round(float(sec), 1) if isinstance(sec, (int, float)) else None})
            s = p["scan"]
            out.append({"pano": i, "yaw": float(s.get("yaw", 0)), "pitch": float(s.get("pitch", 0)),
                        "fov": float(s.get("fov", 75)), "view": p["view"], "edited": p["edited"],
                        "paste_mask": p["mask"], "report": short_report(p["report"])})
        note = (f"Stub: finished case '{case}' from panoramas {order}, not this command. "
                "Its views and panoramas are the case's own, not the requested start view.")
        return {"views": out, "report": overall(out), "stub": True, "note": note}


class GraphRunner:
    """Phase 2. Waits for Mateo-Agent's GO entry in tools/edit_agent/notes/from-edit.md."""

    name = "graph"

    def run(self, job: dict, emit) -> dict:
        raise NotImplementedError("the graph runner is wired after GO")


RUNNERS = {"stub": StubRunner, "graph": GraphRunner}

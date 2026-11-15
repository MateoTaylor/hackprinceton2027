"""What runs an edit. Both runners return the same shape, which `jobs.py` turns into the contract:

    {"views": [{"pano": index, "yaw", "pitch", "fov", "view": Path, "edited": Path,
                "paste_mask": Path, "report": {verdict, issues, notes, summary}}, ...],
     "report": {verdict, issues, notes, summary}, "stub": bool, "note": str,
     "skipped": [{pano, why}], "single_view": str | None}

The first view is the starting panorama's. `views` holds only views that were edited, so it can be
empty. Paths are files on this PC; they never leave this module except as pixels.

- StubRunner (Phase 1) builds that from finished runs in data/edit_agent/runs/. No GPU, no model.
- GraphRunner (Phase 2) runs Mateo-Agent's `all_views` graph on 127.0.0.1:2025.
"""
from __future__ import annotations

import json
import re
import time
from collections import defaultdict
from pathlib import Path

from config import DATA, PIPELINE_URL

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
    """Phase 2: one run of Mateo-Agent's `all_views` graph on 127.0.0.1:2025 per job (GO, 22:14).

    The input is built here from checked fields only. The graph's own paths and flags (run_dir, refs,
    note, carried, mask, image, raw) are never sent. Its result maps onto the shape above: the graph's
    `before` is our `view`, and each record's flat verdict, issues, notes and summary are its report.
    """

    name = "graph"
    GRAPH = "all_views"
    MAX_VIEWS = 4
    # Step fields passed on to the web app. Anything else in a custom event stays on this PC.
    STEP_KEYS = ("step", "status", "seconds", "pano", "view", "panos", "verdict")

    def run(self, job: dict, emit) -> dict:
        import httpx
        from langgraph_sdk import get_sync_client

        start = job["start"]
        inp = {"scan": {"model": job["model_id"], "pano": int(start["index"]), "yaw": float(start["yaw"]),
                        "pitch": float(start["pitch"]), "fov": float(start["fov"])},
               "request": job["command"], "preset": job["preset"],
               "name": "api-" + job["dir"].name.rsplit("-", 1)[-1], "max_views": self.MAX_VIEWS}
        # api_key=None: the SDK would otherwise send a LangSmith key from the environment.
        client = get_sync_client(url=PIPELINE_URL, api_key=None, timeout=httpx.Timeout(10.0, read=900.0))
        last = None
        try:
            for part in client.runs.stream(None, self.GRAPH, input=inp, stream_mode=["custom", "values"]):
                kind = part.event.split("|", 1)[0]
                if kind == "custom" and isinstance(part.data, dict):
                    emit({k: part.data[k] for k in self.STEP_KEYS if k in part.data})
                elif kind == "values" and isinstance(part.data, dict):
                    last = part.data
                elif kind == "error":
                    raise RuntimeError(f"the edit graph failed: {str(part.data)[:300]}")
        except httpx.ConnectError as err:
            raise ConnectionError(str(err)) from err
        if not last or "views" not in last:
            raise RuntimeError("the edit graph returned no result")
        return self.result(last)

    @staticmethod
    def _path(value) -> Path:
        """A picture the graph wrote. It must lie in the runs folder; nothing else is ever opened."""
        path = Path(value).resolve()
        if not path.is_relative_to(RUNS.resolve()) or not path.is_file():
            raise RuntimeError("the edit graph returned a picture outside its runs folder")
        return path

    @classmethod
    def result(cls, out: dict) -> dict:
        records = out.get("views") or []
        views, every = [], []
        for rec in records:
            rep = {"verdict": rec.get("verdict"), "issues": rec.get("issues") or [],
                   "notes": rec.get("notes") or [], "summary": rec.get("summary") or ""}
            every.append({"pano": int(rec["pano"]), "report": rep})
            if not rec.get("edited") or not rec.get("paste_mask"):
                continue                                  # not_found: nothing to paste
            views.append({"pano": int(rec["pano"]), "yaw": float(rec["yaw"]), "pitch": float(rec["pitch"]),
                          "fov": float(rec["fov"]), "view": cls._path(rec["before"]),
                          "edited": cls._path(rec["edited"]), "paste_mask": cls._path(rec["paste_mask"]),
                          "report": rep})
        report = overall(every)                           # issues and notes of every view, found or not
        graph = out.get("report") or {}
        if graph.get("verdict") in ("pass", "fix"):
            report["verdict"] = graph["verdict"]
        if not views:
            report["verdict"] = "fix"                     # nothing was edited, so nothing passed
        if graph.get("summary"):
            report["summary"] = graph["summary"]
        skipped = [{"pano": int(s["pano"]), "why": str(s.get("why", ""))} for s in out.get("skipped") or []
                   if isinstance(s, dict) and "pano" in s]
        single = out.get("single_view")
        return {"views": views, "report": report, "stub": False, "skipped": skipped,
                "single_view": str(single) if single else None}


RUNNERS = {"stub": StubRunner, "graph": GraphRunner}

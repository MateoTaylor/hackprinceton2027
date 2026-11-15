"""Jobs: one at a time, the rest queued. Each job resolves its scan, runs the edit, turns the edited
views into cube faces and writes everything a client may fetch into data/edit_api/jobs/<id>/files/.
"""
from __future__ import annotations

import asyncio
import json
import secrets
import shutil
import threading
import time
import traceback
from collections import deque
from pathlib import Path

from PIL import Image, ImageDraw

import faces
import places
from config import JOBS, MAX_QUEUED, SAFE_ID
from places import ApiError

TERMINAL = ("done", "failed", "cancelled")


def now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


def new_id() -> str:
    return time.strftime("%Y%m%d-%H%M%S-") + secrets.token_hex(3)


class Job:
    def __init__(self, kind: str, model_id: str, start: dict | None = None, command: str = "",
                 preset: str = "720", jid: str | None = None):
        self.id = jid or new_id()
        self.kind = kind
        self.model_id = model_id
        self.start = start or {}
        self.command = command
        self.preset = preset
        self.status = "queued"
        self.created, self.started, self.finished = now(), None, None
        self.steps: list[dict] = []
        self.events: list[dict] = []
        self.result: dict | None = None
        self.error: dict | None = None
        self.changed = asyncio.Event()
        self.dir = JOBS / self.id

    def public(self, position: int | None) -> dict:
        return {"job_id": self.id, "kind": self.kind, "status": self.status, "queue_position": position,
                "created": self.created, "started": self.started, "finished": self.finished,
                "place": {"model_id": self.model_id}, "start": self.start or None,
                "command": self.command or None, "steps": self.steps, "result": self.result, "error": self.error}

    def save(self) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        (self.dir / "job.json").write_text(json.dumps(self.public(None), indent=1), encoding="utf-8")

    @classmethod
    def load(cls, path: Path) -> "Job":
        d = json.loads(path.read_text(encoding="utf-8"))
        job = cls(d["kind"], d["place"]["model_id"], d.get("start") or {}, d.get("command") or "", jid=d["job_id"])
        job.status, job.created, job.started, job.finished = d["status"], d["created"], d["started"], d["finished"]
        job.steps, job.result, job.error = d["steps"], d["result"], d["error"]
        if job.status not in TERMINAL:
            job.status, job.error = "failed", {"code": "interrupted", "message": "the API restarted during this job"}
        job.events = [{"event": "status", "data": {"status": job.status}}]
        job.events.append({"event": "done", "data": job.result} if job.status == "done"
                          else {"event": "failed", "data": job.error})
        return job


class Queue:
    def __init__(self, runner):
        self.runner = runner
        self.jobs: dict[str, Job] = {}
        self.waiting: deque[str] = deque()
        self.wake = asyncio.Event()
        self.loop: asyncio.AbstractEventLoop | None = None
        self.lock = threading.Lock()
        for path in sorted(JOBS.glob("*/job.json")):
            try:
                job = Job.load(path)
                self.jobs[job.id] = job
            except (KeyError, ValueError, OSError):
                continue

    # ------------------------------------------------------------ called from the event loop

    def submit(self, job: Job) -> Job:
        if len(self.waiting) >= MAX_QUEUED:
            raise ApiError(503, "busy", f"{len(self.waiting)} jobs are already waiting; try again later")
        self.jobs[job.id] = job
        self.waiting.append(job.id)
        job.save()
        self._event(job, "status", {"status": "queued", "queue_position": self.position(job)})
        self.wake.set()
        return job

    def position(self, job: Job) -> int | None:
        if job.status != "queued":
            return None
        try:
            return self.waiting.index(job.id) + 1
        except ValueError:
            return None

    def get(self, jid: str) -> Job:
        if not SAFE_ID.match(jid or "") or jid not in self.jobs:
            raise ApiError(404, "unknown_job", "no job with that id")
        return self.jobs[jid]

    def cancel(self, job: Job) -> None:
        if job.status != "queued":
            raise ApiError(409, "not_cancellable", "only a queued job can be cancelled")
        self.waiting.remove(job.id)
        job.status, job.finished = "cancelled", now()
        job.error = {"code": "cancelled", "message": "cancelled before it started"}
        job.save()
        self._event(job, "failed", job.error)
        self._requeue_positions()

    def _event(self, job: Job, event: str, data: dict | None) -> None:
        job.events.append({"event": event, "data": data})
        job.changed.set()
        job.changed = asyncio.Event()

    def _requeue_positions(self) -> None:
        for jid in self.waiting:
            j = self.jobs[jid]
            self._event(j, "status", {"status": "queued", "queue_position": self.position(j)})

    async def worker(self) -> None:
        self.loop = asyncio.get_running_loop()
        while True:
            if not self.waiting:
                self.wake.clear()
                await self.wake.wait()
                continue
            job = self.jobs[self.waiting.popleft()]
            self._requeue_positions()
            job.started = now()
            await asyncio.to_thread(self._run, job)

    # ------------------------------------------------------------ called from the worker thread

    def _emit(self, job: Job, event: str, data: dict) -> None:
        self.loop.call_soon_threadsafe(self._event, job, event, data)

    def _status(self, job: Job, status: str) -> None:
        job.status = status
        job.save()
        self._emit(job, "status", {"status": status})

    def _step(self, job: Job, step: dict) -> None:
        step = {**step, "at": now()}
        job.steps.append(step)
        self._emit(job, "step", step)

    def _run(self, job: Job) -> None:
        log = job.dir / "job.log"
        emit = lambda s: self._step(job, s)
        try:
            self._status(job, "fetching")
            m = places.ensure(job.model_id, log, emit)
            if job.kind == "fetch":
                job.result = places.summary(job.model_id)
            else:
                index = places.pano_index(m, job.start["pano_id"])
                job.start["index"] = index
                self._status(job, "running")
                out = self.runner.run({"model_id": job.model_id, "start": job.start, "command": job.command,
                                       "preset": job.preset, "dir": job.dir}, emit)
                job.result = self._result(job, m, out, emit)
            job.status, job.finished = "done", now()
            job.save()
            self._emit(job, "done", job.result)
        except ApiError as err:
            self._fail(job, err.code, err.message)
        except ConnectionError:
            self._fail(job, "pipeline_unavailable", "the edit pipeline on this PC is not reachable")
        except Exception as err:
            with open(log, "a", encoding="utf-8") as fh:
                fh.write(traceback.format_exc())
            self._fail(job, "edit_failed", f"the edit failed ({type(err).__name__})")

    def _fail(self, job: Job, code: str, message: str) -> None:
        job.status, job.finished = "failed", now()
        job.error = {"code": code, "message": message}
        job.save()
        self._emit(job, "failed", job.error)

    # ------------------------------------------------------------ the result, in the contract's shape

    def _result(self, job: Job, m: dict, out: dict, emit) -> dict:
        files = job.dir / "files"
        files.mkdir(parents=True, exist_ok=True)
        url = lambda name: f"/edits/{job.id}/files/{name}"
        locs = m["locations"]
        done: dict[int, dict] = {}                  # pano index -> {face: path}, so views of one pano chain
        panos: dict[int, dict] = {}
        rows = []
        emit({"step": "faces", "status": "started"})
        t = time.time()
        for k, v in enumerate(out["views"]):
            i = v["pano"]
            res = faces.paste_view(job.model_id, i, v["yaw"], v["pitch"], v["fov"], v["view"], v["edited"],
                                   v["paste_mask"], files, base=done.get(i), prefix=f"p{i}_f")
            done.setdefault(i, {}).update(res["faces"])
            tag = f"p{i}_v{k}"
            before, edited = Image.open(v["view"]).convert("RGB"), Image.open(v["edited"]).convert("RGB")
            before.save(files / f"{tag}_before.jpg", quality=90)
            edited.save(files / f"{tag}_edited.jpg", quality=90)
            shutil.copyfile(v["paste_mask"], files / f"{tag}_mask.png")
            rows.append((i, before, edited))
            loc = locs[i]
            entry = panos.setdefault(i, {
                "id": loc["id"], "location_id": loc.get("location_id"), "index": i,
                "position": loc["position"], "rotation": loc["rotation"],
                "faces": [], "changed": [], "verdict": None, "views": []})
            entry["views"].append({
                "yaw": v["yaw"], "pitch": v["pitch"], "fov": v["fov"], "width": edited.width, "height": edited.height,
                "before": url(f"{tag}_before.jpg"), "edited": url(f"{tag}_edited.jpg"), "mask": url(f"{tag}_mask.png"),
                "report": v["report"]})
        for i, entry in panos.items():
            changed = sorted(done.get(i, {}))
            entry["changed"] = changed
            entry["faces"] = [url(f"p{i}_f{n}.jpg") if n in changed else places.face_url(job.model_id, locs[i]["id"], n)
                              for n in range(6)]
            verdicts = [vw["report"]["verdict"] for vw in entry["views"]]
            entry["verdict"] = "pass" if all(x == "pass" for x in verdicts) else "fix"
        emit({"step": "faces", "status": "done", "seconds": round(time.time() - t, 1)})
        if rows:                                    # no edited view (nothing found): no faces, no preview
            self._preview(rows, files / "preview.jpg")
        skipped = [{"id": locs[s["pano"]]["id"], "index": s["pano"], "why": s["why"]}
                   for s in out.get("skipped") or [] if 0 <= s["pano"] < len(locs)]
        result = {
            "job_id": job.id, "stub": bool(out.get("stub")), "model_id": job.model_id, "command": job.command,
            "has_mesh": places.has_mesh(m, job.model_id), "frame": places.FRAME,
            "start": {k: job.start[k] for k in ("pano_id", "index", "yaw", "pitch", "fov")},
            "panos": list(panos.values()), "report": out["report"],
            "preview": url("preview.jpg") if rows else None,
            "skipped": skipped, "single_view": out.get("single_view"),
        }
        if out.get("note"):
            result["note"] = out["note"]
        return result

    @staticmethod
    def _preview(rows, dest: Path, side: int = 384) -> None:
        """Before | after for every view, one row each, labelled with the panorama index."""
        sheet = Image.new("RGB", (2 * side, side * len(rows)), (24, 24, 24))
        draw = ImageDraw.Draw(sheet)
        for r, (i, before, edited) in enumerate(rows):
            for c, im in enumerate((before, edited)):
                sheet.paste(im.resize((side, side * im.height // im.width)), (c * side, r * side))
            draw.text((6, r * side + 4), f"pano {i}  before", fill=(255, 255, 0))
            draw.text((side + 6, r * side + 4), "after", fill=(255, 255, 0))
        sheet.save(dest, quality=88)

"""The edit API: the web app on another laptop sends edit commands into the scan edit pipeline on
this PC and gets the edited panoramas back. The contract is in README.md.

    .venv\\Scripts\\python server.py [--runner graph|stub]      graph (the default) runs the real pipeline
    .venv\\Scripts\\python server.py --make-token      write a random EDIT_API_TOKEN into .env

Binds 127.0.0.1 and EDIT_API_HOST (one address, never 0.0.0.0), port 2026. Every request needs
`Authorization: Bearer <EDIT_API_TOKEN>` and must come from this PC or an address in EDIT_API_ALLOW.
"""
from __future__ import annotations

import argparse
import asyncio
import hmac
import json
import math
import re
import socket
import sys
import unicodedata
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))

import httpx
import uvicorn
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

import config
import places
from jobs import Job, Queue
from places import ApiError
from runners import RUNNERS

SETTINGS = config.Settings()
FILE_NAME = re.compile(r"^[A-Za-z0-9_-]{1,80}\.(jpg|png)$")
ID = r"^[A-Za-z0-9_-]{1,64}$"


# ---------------------------------------------------------------- request bodies (nothing else is accepted)

class Place(BaseModel):
    model_config = ConfigDict(extra="forbid")
    model_id: Optional[str] = Field(None, pattern=ID)
    property_id: Optional[str] = Field(None, pattern=ID)

    @model_validator(mode="after")
    def one(self):
        if bool(self.model_id) == bool(self.property_id):
            raise ValueError("give exactly one of place.model_id and place.property_id")
        return self


class Start(BaseModel):
    model_config = ConfigDict(extra="forbid")
    pano_id: str = Field(pattern=ID)
    yaw: float = Field(description="degrees, world frame, from +X towards +Y")
    pitch: float = Field(0.0, ge=-89.0, le=89.0)
    fov: float = Field(70.0, ge=30.0, le=120.0)

    @field_validator("yaw")
    @classmethod
    def wrap(cls, v: float) -> float:
        if not math.isfinite(v):
            raise ValueError("yaw must be a finite number")
        return round(v % 360.0, 3)


class EditIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    place: Place
    start: Start
    command: str = Field(min_length=3, max_length=300)
    preset: Literal["720", "fast", "draft", "quality"] = "720"

    @field_validator("command")
    @classmethod
    def clean(cls, v: str) -> str:
        v = "".join(ch for ch in v if unicodedata.category(ch)[0] != "C" or ch == " ")
        v = " ".join(v.split())
        if len(v) < 3:
            raise ValueError("command is empty")
        return v


# ---------------------------------------------------------------- the app

QUEUE: Queue | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global QUEUE
    QUEUE = Queue(app.state.runner)
    task = asyncio.create_task(QUEUE.worker())
    yield
    task.cancel()


def make_app(runner_name: str = "stub") -> FastAPI:
    app = FastAPI(title="Edit API", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
    app.state.runner = RUNNERS[runner_name]()
    if SETTINGS.cors:
        app.add_middleware(CORSMiddleware, allow_origins=SETTINGS.cors, allow_methods=["GET", "POST", "DELETE"],
                           allow_headers=["Authorization", "X-API-Key", "Content-Type", "Last-Event-ID"], max_age=600)

    seen: set[str] = set()

    @app.middleware("http")
    async def guard(request: Request, call_next):
        client = request.client.host if request.client else ""
        if client not in seen:                               # one line per new caller, to narrow EDIT_API_ALLOW later
            seen.add(client)
            print(f"edit API: first request from {client} "
                  f"({'allowed' if SETTINGS.allows(client) else 'refused by EDIT_API_ALLOW'})", flush=True)
        if not SETTINGS.allows(client):
            return JSONResponse({"error": {"code": "forbidden", "message": "this address is not allowed",
                                           "address": client}}, 403)
        if request.method == "OPTIONS":                      # CORS preflight carries no token
            return await call_next(request)
        path = request.url.path
        if ".." in path or "/." in path:
            return JSONResponse({"error": {"code": "not_found", "message": "not found"}}, 404)
        if path != "/health":
            header = request.headers.get("authorization", "")
            token = header[7:] if header.lower().startswith("bearer ") else request.headers.get("x-api-key", "")
            if not token or not hmac.compare_digest(token.encode(), SETTINGS.token.encode()):
                return JSONResponse({"error": {"code": "unauthorized", "message": "missing or wrong bearer token"}},
                                    401, headers={"WWW-Authenticate": "Bearer"})
        return await call_next(request)

    @app.exception_handler(ApiError)
    async def api_error(_: Request, err: ApiError):
        return JSONResponse(err.body(), err.status)

    @app.exception_handler(RequestValidationError)
    async def bad_request(_: Request, err: RequestValidationError):
        problems = [f"{'.'.join(str(p) for p in e['loc'][1:])}: {e['msg']}" for e in err.errors()]
        return JSONResponse({"error": {"code": "bad_request", "message": "; ".join(problems)[:600]}}, 400)

    @app.exception_handler(404)
    async def not_found(_: Request, __):
        return JSONResponse({"error": {"code": "not_found", "message": "not found"}}, 404)

    # ------------------------------------------------------------ routes

    @app.get("/health")
    async def health():
        out = {"ok": True, "runner": app.state.runner.name}
        if app.state.runner.name == "graph":              # is the edit graph on this PC up? (no token needed)
            try:
                async with httpx.AsyncClient(timeout=1.5) as http:
                    out["pipeline"] = (await http.get(f"{config.PIPELINE_URL}/ok")).status_code == 200
            except httpx.HTTPError:
                out["pipeline"] = False
        return out

    @app.get("/places")
    async def list_places():
        return {"places": places.listing()}

    @app.get("/places/{model_id}")
    async def get_place(model_id: str):
        return places.summary(places.check_id(model_id, "model_id"))

    @app.post("/places/{model_id}/fetch", status_code=202)
    async def fetch_place(model_id: str):
        job = QUEUE.submit(Job("fetch", places.check_id(model_id, "model_id")))
        return job.public(QUEUE.position(job))

    @app.get("/places/{model_id}/panos/{pano_id}/faces/{n}")
    async def original_face(model_id: str, pano_id: str, n: int):
        path = places.face_file(places.check_id(model_id, "model_id"), pano_id, n)
        return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=86400"})

    @app.post("/edits", status_code=202)
    async def post_edit(body: EditIn):
        model_id = places.resolve(body.place.model_dump())
        m = places.manifest(model_id)
        if m is not None:
            places.pano_index(m, body.start.pano_id)          # unknown_pano now, not after the queue
        job = QUEUE.submit(Job("edit", model_id, body.start.model_dump(), body.command, body.preset))
        return job.public(QUEUE.position(job))

    @app.get("/edits")
    async def list_edits():
        jobs = sorted(QUEUE.jobs.values(), key=lambda j: j.created, reverse=True)[:50]
        return {"jobs": [{"job_id": j.id, "kind": j.kind, "status": j.status, "created": j.created,
                          "model_id": j.model_id, "queue_position": QUEUE.position(j)} for j in jobs]}

    @app.get("/edits/{job_id}")
    async def get_edit(job_id: str):
        job = QUEUE.get(job_id)
        return job.public(QUEUE.position(job))

    @app.delete("/edits/{job_id}")
    async def cancel_edit(job_id: str):
        job = QUEUE.get(job_id)
        QUEUE.cancel(job)
        return job.public(None)

    @app.get("/edits/{job_id}/events")
    async def events(job_id: str, request: Request):
        job = QUEUE.get(job_id)
        try:
            start = int(request.headers.get("last-event-id", "-1")) + 1
        except ValueError:
            start = 0

        async def stream():
            i = max(0, start)
            yield "retry: 3000\n\n"
            while True:
                changed = job.changed                       # taken first, so an event during a yield wakes us
                while i < len(job.events):
                    ev = job.events[i]
                    yield f"id: {i}\nevent: {ev['event']}\ndata: {json.dumps(ev['data'])}\n\n"
                    i += 1
                    # Every job ends with a done or failed event. End on that event, not on job.status:
                    # the worker thread sets the status before its last event reaches this loop.
                    if ev["event"] in ("done", "failed"):
                        return
                if await request.is_disconnected():
                    return
                try:
                    await asyncio.wait_for(changed.wait(), timeout=15)
                except asyncio.TimeoutError:
                    yield ": keep-alive\n\n"

        return StreamingResponse(stream(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    @app.get("/edits/{job_id}/files/{name}")
    async def job_file(job_id: str, name: str):
        job = QUEUE.get(job_id)
        if not FILE_NAME.match(name):
            raise ApiError(404, "not_found", "no such file")
        base = (job.dir / "files").resolve()
        path = (base / name).resolve()
        if not path.is_relative_to(base) or not path.is_file():
            raise ApiError(404, "not_found", "no such file")
        media = "image/png" if name.endswith(".png") else "image/jpeg"
        return FileResponse(path, media_type=media, headers={"Cache-Control": "private, max-age=86400"})

    return app


def sockets() -> list[socket.socket]:
    """127.0.0.1 always, plus EDIT_API_HOST when it is another address."""
    out = []
    for host in dict.fromkeys(["127.0.0.1", SETTINGS.host]):
        family = socket.AF_INET6 if ":" in host else socket.AF_INET
        s = socket.socket(family, socket.SOCK_STREAM)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE if hasattr(socket, "SO_EXCLUSIVEADDRUSE")
                     else socket.SO_REUSEADDR, 1)
        try:
            s.bind((host, config.PORT))
        except OSError as err:
            s.close()
            if host == "127.0.0.1":
                raise
            here = sorted({a[4][0] for a in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)})
            sys.exit(f"Cannot bind EDIT_API_HOST {host}:{config.PORT} ({err.strerror}). If the Wi-Fi address "
                     f"changed, set EDIT_API_HOST in .env to one of this PC's addresses now: {', '.join(here)}")
        out.append(s)
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--runner", choices=sorted(RUNNERS), default="graph")
    ap.add_argument("--make-token", action="store_true", help="write a random EDIT_API_TOKEN into .env if it has none")
    args = ap.parse_args()
    if args.make_token:
        print("EDIT_API_TOKEN written to .env" if config.make_token() else ".env already has EDIT_API_TOKEN")
        return
    problems = SETTINGS.check()
    if problems:
        sys.exit("Not starting:\n- " + "\n- ".join(problems))
    socks = sockets()
    print(f"edit API ({args.runner}) on " + ", ".join(f"{s.getsockname()[0]}:{config.PORT}" for s in socks)
          + f"; allowed clients: {SETTINGS.describe_allow()}", flush=True)
    server = uvicorn.Server(uvicorn.Config(make_app(args.runner), log_level="info", access_log=True))
    server.run(sockets=socks)


if __name__ == "__main__":
    main()

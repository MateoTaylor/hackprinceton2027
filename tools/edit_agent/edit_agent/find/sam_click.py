"""SAM 2.1 for clicks, kept warm between clicks. Runs in tools/qwen_test/.venv-sam (it needs PyTorch).

  ..\\qwen_test\\.venv-sam\\Scripts\\python -I edit_agent\\find\\sam_click.py serve [--port 2027] [--idle 900]
  ..\\qwen_test\\.venv-sam\\Scripts\\python -I edit_agent\\find\\sam_click.py once --jobs jobs.json

Starting a SAM process costs about 4.5 s (PyTorch, CUDA, 900 MB of weights). `serve` pays it once.
The model then waits in CPU memory. Each request takes the shared GPU lock (edit_agent/gpu.py),
moves the model to the GPU, answers, moves it back and frees the cache. Between clicks this process
holds no lock and no weights on the GPU, only its CUDA context. The image features of the last few
views are kept (on the CPU), so a second click on the same view skips the image encoder. The server
exits after --idle seconds without a request. It listens on 127.0.0.1 only.

A job (POST /segment, or one entry of --jobs):
  {"image": path, "points": [[x, y], ...], "labels": [1, 0, ...], "box": [x0, y0, x1, y1] or null,
   "multimask": true, "out": "path/prefix", "lock": true}
"lock": false only when the caller holds the GPU lock itself for this request.
Pixels of the image. The answer: {"masks": [{"path", "score", "area", "box"}], "seconds", "cached"}.
With multimask SAM returns three outlines of the click (a part, the object, a group); they come
back sorted from small to large. `once` writes each job's answer into the job.
"""
import argparse
import json
import sys
import threading
import time
from collections import OrderedDict
from contextlib import nullcontext
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np
import torch
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))       # tools/edit_agent
from edit_agent import gpu                                         # noqa: E402  the shared GPU lock
from edit_agent.config import QWEN                                 # noqa: E402

CHECKPOINT = QWEN / "models" / "sam2.1_hiera_large.pt"
CONFIG = "configs/sam2.1/sam2.1_hiera_l.yaml"
KEEP_VIEWS = 4


class Clicker:
    def __init__(self):
        from sam2.build_sam import build_sam2
        from sam2.sam2_image_predictor import SAM2ImagePredictor
        t0 = time.time()
        self.model = build_sam2(CONFIG, str(CHECKPOINT), device="cpu")
        self.predictor = SAM2ImagePredictor(self.model)
        self.features = OrderedDict()          # (path, mtime) -> (features on the CPU, original size)
        self.lock = threading.Lock()
        self.load_s = round(time.time() - t0, 1)

    def _set_image(self, path):
        key = (str(path), Path(path).stat().st_mtime_ns)
        p = self.predictor
        if key in self.features:
            feats, hw = self.features[key]
            self.features.move_to_end(key)
            p._features = {"image_embed": feats["image_embed"].cuda(),
                           "high_res_feats": [f.cuda() for f in feats["high_res_feats"]]}
            p._orig_hw, p._is_image_set = [hw], True
            return True
        p.set_image(np.asarray(Image.open(path).convert("RGB")))
        f = p._features
        self.features[key] = ({"image_embed": f["image_embed"].cpu(),
                               "high_res_feats": [x.cpu() for x in f["high_res_feats"]]}, p._orig_hw[0])
        while len(self.features) > KEEP_VIEWS:
            self.features.popitem(last=False)
        return False

    def segment(self, job):
        t0 = time.time()
        pts = np.array(job["points"], np.float32) if job.get("points") else None
        labels = np.array(job["labels"], np.int32) if job.get("points") else None
        box = np.array(job["box"], np.float32) if job.get("box") else None
        multi = bool(job.get("multimask", True))
        # "lock": false means the caller already holds the GPU lock for us (a finder that has the
        # VLM loaded). Taking it here as well would wait forever: the lock is per process.
        with self.lock, (gpu.exclusive() if job.get("lock", True) else nullcontext()):
            self.model.to("cuda")
            try:
                with torch.inference_mode(), torch.autocast("cuda", dtype=torch.bfloat16):
                    cached = self._set_image(job["image"])
                    masks, scores, _ = self.predictor.predict(point_coords=pts, point_labels=labels, box=box,
                                                              multimask_output=multi)
            finally:
                self.model.to("cpu")
                self.predictor.reset_predictor()
                torch.cuda.empty_cache()
        out = []
        for m, s in zip(masks > 0, scores):
            ys, xs = np.nonzero(m)
            out.append({"mask": m, "score": round(float(s), 3), "area": int(m.sum()),
                        "box": [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1] if len(xs) else None})
        out.sort(key=lambda r: r["area"])
        for i, r in enumerate(out):
            r["path"] = f"{job['out']}_{i}.png"
            Image.fromarray(r.pop("mask").astype(np.uint8) * 255).save(r["path"])
        return {"masks": out, "seconds": round(time.time() - t0, 2), "cached": cached}


def serve(args):
    clicker = Clicker()
    last = [time.time()]

    class Handler(BaseHTTPRequestHandler):
        def _send(self, code, body):
            data = json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path == "/health":
                self._send(200, {"ok": True, "load_s": clicker.load_s, "views": len(clicker.features)})
            else:
                self._send(404, {"error": "not found"})

        def do_POST(self):
            if self.path != "/segment":
                return self._send(404, {"error": "not found"})
            last[0] = time.time()
            try:
                job = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                self._send(200, clicker.segment(job))
            except Exception as e:                       # report, keep serving
                self._send(500, {"error": f"{type(e).__name__}: {e}"})
            last[0] = time.time()

        def log_message(self, *a):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)

    def idle_watch():
        while time.time() - last[0] < args.idle:
            time.sleep(5)
        server.shutdown()

    threading.Thread(target=idle_watch, daemon=True).start()
    print(f"sam_click ready on 127.0.0.1:{args.port} (model loaded in {clicker.load_s} s, exits after "
          f"{args.idle} s idle)", flush=True)
    server.serve_forever()


def once(args):
    clicker = Clicker()
    path = Path(args.jobs)
    jobs = json.loads(path.read_text(encoding="utf-8"))
    for job in jobs:
        job.update(clicker.segment(job))
    path.write_text(json.dumps(jobs, indent=1), encoding="utf-8")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("serve")
    s.add_argument("--port", type=int, default=2027)
    s.add_argument("--idle", type=int, default=900, help="exit after this many seconds without a request")
    o = sub.add_parser("once")
    o.add_argument("--jobs", required=True)
    args = ap.parse_args()
    serve(args) if args.cmd == "serve" else once(args)


if __name__ == "__main__":
    main()

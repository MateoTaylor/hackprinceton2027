"""What every finder mode shares: run folders, coordinates, SAM, the found.json and a picture of the result.

Coordinates: points and boxes that leave the finder are on the 0-1000 scale of the view, the scale
Qwen3-VL writes and `first_pass` reads. Pixels are used only inside a run.
"""
import json
import os
import re
import subprocess
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from edit_agent.config import QWEN, ROOT

FIND = ROOT / "data" / "edit_agent" / "find"      # git-ignored: inventories and runs
RUNS = FIND / "runs"
SAM_PYTHON = QWEN / ".venv-sam" / "Scripts" / "python.exe"
SAM_SERVER = Path(__file__).with_name("sam_click.py")
SAM_PORT = 2027
SAM_URL = f"http://127.0.0.1:{SAM_PORT}"


def run_dir(label):
    label = re.sub(r"[^a-z0-9]+", "-", (label or "find").lower()).strip("-")[:40] or "find"
    stem = RUNS / f"{datetime.now():%Y%m%d-%H%M%S}-{label}"
    run, n = stem, 1
    while run.exists():
        n += 1
        run = stem.with_name(f"{stem.name}-{n}")
    run.mkdir(parents=True)
    return run


def to_px(point, size):
    """A 0-1000 point to pixel coordinates of an image of this size."""
    return [min(max(v, 0), 1000) / 1000 * side for v, side in zip(point, size)]


def to_1000(xy, size):
    """Pixel coordinates (a point or a box) to the 0-1000 scale."""
    return [round(v / size[i % 2] * 1000) for i, v in enumerate(xy)]


def mask_box(mask):
    """[x0, y0, x1, y1] in pixels around the white pixels (x1, y1 exclusive), or None."""
    ys, xs = np.nonzero(mask)
    if not len(xs):
        return None
    return [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1]


def box_iou(a, b):
    ix = max(0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def contains(mask, xy, tol=3):
    """True if the mask has a white pixel within `tol` pixels of the point."""
    h, w = mask.shape
    x, y = int(xy[0]), int(xy[1])
    return bool(mask[max(0, y - tol):min(h, y + tol + 1), max(0, x - tol):min(w, x + tol + 1)].any())


def touches_edge(mask, margin=2):
    return bool(mask[:margin].any() or mask[-margin:].any() or mask[:, :margin].any() or mask[:, -margin:].any())


def mask_iou(a, b):
    union = (a | b).sum()
    return float((a & b).sum() / union) if union else 0.0


def _sam_healthy():
    try:
        with urllib.request.urlopen(SAM_URL + "/health", timeout=2) as r:
            return r.status == 200
    except OSError:
        return False


def ensure_sam(wait=120):
    """Start the warm SAM process (sam_click.py serve) unless it runs. Returns the seconds spent.

    Loading it takes no GPU lock (the weights wait in CPU memory), so a caller may hold the lock."""
    if _sam_healthy():
        return 0.0
    t0 = time.time()
    FIND.mkdir(parents=True, exist_ok=True)
    # A hidden console, not DETACHED_PROCESS: the venv's python.exe is a launcher, and its child got a
    # console window of its own, which closed the server ("window-CLOSE event") when it was closed.
    flags = (subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP) if os.name == "nt" else 0
    subprocess.Popen([str(SAM_PYTHON), "-I", str(SAM_SERVER), "serve", "--port", str(SAM_PORT)],
                     stdout=open(FIND / "sam_click.log", "a", encoding="utf-8"), stderr=subprocess.STDOUT,
                     stdin=subprocess.DEVNULL, creationflags=flags)
    while time.time() - t0 < wait:
        if _sam_healthy():
            return round(time.time() - t0, 1)
        time.sleep(0.5)
    raise RuntimeError(f"the SAM click server did not start, see {FIND / 'sam_click.log'}")


def sam(view, jobs, run, tag="sam", lock=True):
    """Outlines from the warm SAM process, started on first use.

    Each job: {"name", "points": [[x, y]] px, "labels": [1], "box": [x0, y0, x1, y1] px, "multimask"}.
    Returns {name: [candidates, small to large]} with each candidate {mask, score, area, box, path},
    and timing. `lock=False` only when the caller holds the GPU lock itself.
    """
    started = ensure_sam()
    t0 = time.time()
    out = {}
    for j in jobs:
        body = {"image": str(view), "out": str(run / f"{tag}_{j['name']}"), "lock": lock,
                "multimask": j.get("multimask", False), **{k: j[k] for k in ("points", "labels", "box") if k in j}}
        for attempt in (1, 2):
            req = urllib.request.Request(SAM_URL + "/segment", json.dumps(body).encode(), {"Content-Type": "application/json"})
            try:
                with urllib.request.urlopen(req, timeout=300) as r:
                    ans = json.loads(r.read())
                break
            except urllib.error.HTTPError as e:
                raise RuntimeError(f"SAM click server: {e.read().decode(errors='replace')}") from None
            except (ConnectionError, urllib.error.URLError):
                if attempt == 2:
                    raise
                started += ensure_sam()                 # the server went away mid-request: start it again
        out[j["name"]] = [{**m, "mask": np.asarray(Image.open(m["path"]).convert("L")) > 127} for m in ans["masks"]]
    return out, {"sam_s": round(time.time() - t0, 2), "sam_start_s": started}


def save_mask(mask, path):
    Image.fromarray(mask.astype(np.uint8) * 255).save(path)
    return path


def graph_input(request, source, target, mask=None, preset=None, find=None):
    """The found.json: a whole input of `first_pass`. `find` holds the finder's own record; the edit
    graph ignores keys it does not know."""
    out = {"request": request, **source, "target": target}
    if mask:
        out["mask"] = str(mask)
    if preset:
        out["preset"] = preset
    if find:
        out["find"] = find
    return out


def write_found(run, found):
    path = run / "found.json"
    path.write_text(json.dumps(found, indent=2), encoding="utf-8")
    return path


def _font(size):
    for name in ("arialbd.ttf", "arial.ttf", "DejaVuSans-Bold.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            pass
    return ImageFont.load_default()


def sheet(view, out, mask=None, click=None, boxes=(), final=None, caption=""):
    """One picture of a result, for people: mask tinted red, the click as a cross, the VLM's boxes in
    yellow, the handed-over box in green, a caption below. Pixel coordinates."""
    img = Image.open(view).convert("RGB")
    a = np.asarray(img, np.float32).copy()
    if mask is not None and mask.any():
        a[mask] = a[mask] * 0.5 + np.array([255, 40, 40], np.float32) * 0.5
    img = Image.fromarray(a.astype(np.uint8))
    d = ImageDraw.Draw(img)
    for b in boxes:
        d.rectangle(b, outline=(255, 220, 0), width=2)
    if final:
        d.rectangle(final, outline=(40, 255, 80), width=3)
    if click:
        x, y = click
        r = max(6, img.width // 60)
        d.line([x - r, y, x + r, y], fill=(0, 255, 255), width=3)
        d.line([x, y - r, x, y + r], fill=(0, 255, 255), width=3)
    f = _font(max(14, img.width // 48))
    lines = _wrap(caption, f, img.width - 16)
    lh = f.size + 6
    full = Image.new("RGB", (img.width, img.height + lh * len(lines) + 12), (20, 20, 20))
    full.paste(img, (0, 0))
    dd = ImageDraw.Draw(full)
    for i, line in enumerate(lines):
        dd.text((8, img.height + 6 + i * lh), line, fill=(235, 235, 235), font=f)
    full.save(out, quality=90)
    return out


def _wrap(text, font, width):
    lines = []
    for para in text.split("\n"):
        line = ""
        for word in para.split():
            trial = f"{line} {word}".strip()
            if font.getlength(trial) <= width or not line:
                line = trial
            else:
                lines.append(line)
                line = word
        lines.append(line)
    return lines

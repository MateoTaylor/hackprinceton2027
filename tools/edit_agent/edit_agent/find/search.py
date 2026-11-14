"""Search without a click: the thing a request names, in other directions and other panoramas.

  render       a view of the scan at a preset's size, rendered once and reused
  around       the cameras around one panorama: six directions, 60 degrees apart
  nearest      the panoramas, nearest to one of them first
  seen         one closed question about one view: can the thing in the request be seen?
  locate       the edit side's locate question on one view, then SAM in its boxes
  inventory    once per scan: the names of the things in every view, saved under data/
  matches      one text question: which names in the inventory fit the request?
  ranked       the views that name a match, one per panorama, nearest first
  look_around  view and text: here first, then the other directions, then the nearest panoramas
  search       text only: the inventory, then locate on the best few views

Views overlap (75 degrees of view every 60), so a thing cut by one view's edge is whole in the next.
"""
import json
import shutil
import time
from pathlib import Path

import numpy as np
from PIL import Image

from edit_agent import gpu, steps
from edit_agent.config import PRESETS
from edit_agent.find import common, pointer
from edit_agent.find.prompts import NAMES_PROMPT, NAMES_SCHEMA, SEEN_SCHEMA, match_prompt, match_schema, seen_prompt
from edit_agent.schemas import LOCATE_PROMPT, LOCATE_SCHEMA

STEP = 60                   # degrees between directions
PITCH = -10.0               # a little below level: furniture rather than ceiling
FOV = 75.0
VIEWS = common.FIND / "views"
INVENTORY_PRESET = "fast"   # 768 px: small decor is still named
PANOS_PER_LOCK = 3          # the inventory holds the GPU about 25 s at a time
NEAR_PANOS = 2              # without an inventory, look in this many other panoramas
LOCATE_TRIES = 3            # views to locate on, at most
RECENTER_MAX_SHARE = 0.35
ZOOM_BELOW = 0.01           # a thing under 1 % of the view gets a narrower camera...
ZOOM_TO = 0.04              # ...aimed at about 4 % of it...
ZOOM_MIN_FOV = 30.0         # ...but no narrower than this

_scans = {}


def _scan(model):
    from pano import Scan
    if model not in _scans:
        _scans[model] = Scan(model)
    return _scans[model]


def render(scan, preset, run=None):
    """The view of a scan, rendered once per camera and size and then reused (SAM caches its features
    by file). Same camera and size rule as `steps.prepare`, with the panorama kept in memory."""
    from pano import Camera
    key = (f"{scan['model']}_p{scan['pano']}_y{float(scan.get('yaw', 0)):g}_t{float(scan.get('pitch', 0)):g}"
           f"_f{float(scan.get('fov', 75)):g}_{preset.work_px}")
    path = VIEWS / f"{key}.png"
    if not path.exists():
        VIEWS.mkdir(parents=True, exist_ok=True)
        s = _scan(scan["model"])
        px = max(16, round(preset.work_px / 16) * 16)
        cam = Camera.from_angles(s.position(scan["pano"]), scan.get("yaw", 0), scan.get("pitch", 0),
                                 scan.get("fov", 75), px, px)
        tmp = path.with_suffix(".tmp.png")
        s.view(scan["pano"], cam).save(tmp)
        tmp.replace(path)
    return path, Image.open(path).size


def around(model, pano, yaw=0.0, pitch=PITCH, fov=FOV):
    """Six cameras on one panorama, the first one at `yaw`."""
    return [{"model": model, "pano": pano, "yaw": round((yaw + k * STEP) % 360, 1), "pitch": pitch, "fov": fov}
            for k in range(360 // STEP)]


def nearest(model, pano=None):
    """Panorama indices, nearest to `pano` first (straight-line distance)."""
    s = _scan(model)
    if pano is None:
        return list(range(len(s)))
    here = s.position(pano)
    return sorted(range(len(s)), key=lambda i: float(np.linalg.norm(s.position(i) - here)))


def seen(server, preset, view, request):
    """{visible, what}: one closed question, about 0.6 s."""
    return steps.look(server, preset, [view], seen_prompt(request), SEEN_SCHEMA, max_tokens=120)


def locate(server, preset, view, request, run, tag):
    """The edit side's locate question on one view, then SAM in each box (the GPU lock is held).
    Returns (target or None, mask or None, the VLM's answer, timing)."""
    answer, info = steps.look(server, preset, [view], LOCATE_PROMPT.format(text=request), LOCATE_SCHEMA)
    if not answer.get("found") or not answer.get("boxes"):
        return None, None, answer, info
    size = Image.open(view).size
    jobs = [{"name": f"b{i}", "box": steps.to_pixels(b["bbox_2d"], size)} for i, b in enumerate(answer["boxes"])]
    out, sinfo = common.sam(view, jobs, run, tag=tag, lock=False)
    union, boxes = np.zeros((size[1], size[0]), bool), []
    for job, b in zip(jobs, answer["boxes"]):
        cands = out.get(job["name"]) or []
        if cands and cands[0]["box"]:
            union |= cands[0]["mask"]
            boxes.append({"label": b["label"], "bbox_2d": common.to_1000(cands[0]["box"], size)})
    info = {**info, "sam_s": sinfo["sam_s"]}
    if not boxes:
        return None, None, answer, info
    target = {k: answer[k] for k in ("item", "kind", "behind", "instruction")}
    return {**target, "boxes": boxes}, union, answer, info


# --- the inventory ------------------------------------------------------------------------------

def inventory_path(model):
    return common.FIND / model / "inventory.json"


def load_inventory(model):
    p = inventory_path(model)
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


def _clean(names):
    out = []
    for n in names:
        n = " ".join(n.lower().strip(" .").split())
        if n and n not in out:
            out.append(n)
    return out


def build_inventory(model, say=None, preset_name=INVENTORY_PRESET):
    """The names of the things in every view of the scan (six per panorama), saved once."""
    preset = PRESETS[preset_name]
    n = len(_scan(model))
    log = common.FIND / model / "inventory-llama.log"
    log.parent.mkdir(parents=True, exist_ok=True)
    views, t0 = [], time.time()
    for start in range(0, n, PANOS_PER_LOCK):
        batch = [(cam, render(cam, preset)[0]) for p in range(start, min(n, start + PANOS_PER_LOCK))
                 for cam in around(model, p)]                       # rendered before taking the GPU
        with gpu.vlm(preset, log=log) as server:
            for cam, view in batch:
                ans, info = steps.look(server, preset, [view], NAMES_PROMPT, NAMES_SCHEMA, max_tokens=400)
                views.append({**cam, "names": _clean(ans["names"])})
                if say:
                    say({"step": "inventory", "status": "view", "pano": cam["pano"], "yaw": cam["yaw"],
                         "names": views[-1]["names"], "seconds": info["answer_s"]})
    inv = {"model": model, "preset": preset_name, "built": time.strftime("%Y-%m-%d %H:%M"),
           "seconds": round(time.time() - t0, 1), "views": views}
    inventory_path(model).write_text(json.dumps(inv, indent=1), encoding="utf-8")
    return inv


def matches(server, preset, request, inv):
    """Which names in the inventory fit the request: one text question, no picture."""
    names = sorted({n for v in inv["views"] for n in v["names"]})
    if not names:
        return [], {}
    ans, info = steps.look(server, preset, [], match_prompt(request, names), match_schema(names), max_tokens=600)
    return ans["matches"], info


def ranked(inv, hits, order):
    """The views that name a hit, one per panorama (the one naming the most hits), panoramas in `order`."""
    hits, best = set(hits), {}
    for v in inv["views"]:
        k = len(hits & set(v["names"]))
        if k and k > best.get(v["pano"], (0, None))[0]:
            best[v["pano"]] = (k, v)
    return [{k: best[p][1][k] for k in ("model", "pano", "yaw", "pitch", "fov")} | {"names": sorted(hits & set(best[p][1]["names"]))}
            for p in order if p in best]


# --- the two searches ---------------------------------------------------------------------------

def _found(cam, view, target, mask, how):
    return {"status": "found", "reason": how, "scan": {k: cam[k] for k in ("model", "pano", "yaw", "pitch", "fov")},
            "view": str(view), "size": list(Image.open(view).size), "target": target, "mask_array": mask}


def _try_locate(server, preset, cam, request, run, tried, say, note):
    view, _ = render(cam, preset)
    target, mask, answer, info = locate(server, preset, view, request, run, f"p{cam['pano']}_y{cam['yaw']:g}")
    tried.append({"pano": cam["pano"], "yaw": cam["yaw"], "asked": "locate", "found": target is not None,
                  "item": answer.get("item"), "seconds": info.get("answer_s"), "why": note})
    say({"step": "search", "status": "located", **tried[-1]})
    return (view, target, mask) if target else None


def _recentre(server, preset, hit, request, run, tried, say):
    """Turn the camera onto the thing, on the same panorama, and locate again: when it touches the
    view's edge (cut off), or when it is so small that the edit would have few pixels (zoom in)."""
    mask = hit["mask_array"]
    share = float(mask.mean())
    cut = common.touches_edge(mask) and share <= RECENTER_MAX_SHARE
    small = share < ZOOM_BELOW
    if not (cut or small):
        return hit
    fov = hit["scan"]["fov"]
    if small:       # the share grows with 1/fov^2 (roughly): aim for ZOOM_TO of the view
        fov = max(ZOOM_MIN_FOV, fov * (share / ZOOM_TO) ** 0.5)
    ys, xs = np.nonzero(mask)
    centre = common.to_1000([float(xs.mean()), float(ys.mean())], hit["size"])
    cam, _ = pointer.recenter(hit["scan"], hit["size"], mask, centre, fov=fov)
    got = _try_locate(server, preset, cam, request, run, tried, say, "zoom in on the thing" if small else "recentre on the thing")
    if got:
        view, target, m = got
        if not common.touches_edge(m) or m.sum() >= 0.8 * mask.sum():
            return _found(cam, view, target, m, hit["reason"] + (", zoomed in" if small else ", recentred"))
    return hit


def look_around(scan, request, preset, run, say):
    """View and text. Here first; if the thing is not in view, the other directions of this panorama,
    then the nearest panoramas. With an inventory the other views come from it; without, a yes/no
    question per view picks the ones worth a locate."""
    model, tried = scan["model"], []
    inv = load_inventory(model)
    with gpu.vlm(preset, log=run / "llama-server.log") as server:
        got = _try_locate(server, preset, scan, request, run, tried, say, "the user's view")
        if got:
            return _recentre(server, preset, _found(scan, *got, "in the user's view"), request, run, tried, say), tried, []
        if inv:
            hits, _ = matches(server, preset, request, inv)
            say({"step": "search", "status": "matched", "hits": hits})
            for cam in ranked(inv, hits, nearest(model, scan["pano"]))[:LOCATE_TRIES]:
                got = _try_locate(server, preset, cam, request, run, tried, say, f"the inventory names {cam['names']}")
                if got:
                    how = "elsewhere on this panorama" if cam["pano"] == scan["pano"] else f"from panorama {cam['pano']}"
                    return _recentre(server, preset, _found(cam, *got, how + " (inventory)"), request, run, tried, say), tried, hits
            return None, tried, hits
    # No inventory: ask yes or no per view. This panorama first, then the nearest ones, one GPU hold each.
    turns = around(model, scan["pano"], scan.get("yaw", 0))
    blocks = [[turns[k] for k in (1, 5, 2, 4, 3)]]          # 60 degrees left and right first, behind last
    blocks += [around(model, p) for p in nearest(model, scan["pano"])[1:1 + NEAR_PANOS]]
    for cams in blocks:
        views = [(cam, render(cam, preset)[0]) for cam in cams]
        with gpu.vlm(preset, log=run / "llama-server.log") as server:
            for cam, view in views:
                ans, info = seen(server, preset, view, request)
                tried.append({"pano": cam["pano"], "yaw": cam["yaw"], "asked": "seen", "found": ans["visible"],
                              "item": ans["what"], "seconds": info["answer_s"]})
                say({"step": "search", "status": "seen", **tried[-1]})
                if ans["visible"]:
                    got = _try_locate(server, preset, cam, request, run, tried, say, "seen: " + ans["what"])
                    if got:
                        how = "elsewhere on this panorama" if cam["pano"] == scan["pano"] else f"from panorama {cam['pano']}"
                        return _recentre(server, preset, _found(cam, *got, how), request, run, tried, say), tried, []
    return None, tried, []


def search(model, request, preset, run, say, near=None):
    """Text only. The inventory (built on first use, about 1.5 min) gives the views that name a match;
    locate runs on the best few. Every view where the thing was found is a candidate, so a request
    that fits several things (five pillows) comes back with all of them, ranked."""
    inv = load_inventory(model)
    if inv is None:
        say({"step": "search", "status": "building inventory"})
        inv = build_inventory(model, say)
    tried, found = [], []
    with gpu.vlm(preset, log=run / "llama-server.log") as server:
        hits, _ = matches(server, preset, request, inv)
        say({"step": "search", "status": "matched", "hits": hits})
        order = nearest(model, near)
        cams = ranked(inv, hits, order)
        if near is None:        # no user position: the panoramas that name the match most often first
            count = {p: sum(1 for v in inv["views"] if v["pano"] == p and set(hits) & set(v["names"])) for p in order}
            cams.sort(key=lambda c: -count[c["pano"]])
        for cam in cams[:LOCATE_TRIES]:
            got = _try_locate(server, preset, cam, request, run, tried, say, f"the inventory names {cam['names']}")
            if got:
                found.append(_found(cam, *got, f"panorama {cam['pano']} (inventory names {cam['names']})"))
        if not found:
            return None, tried, hits, []
        if near is None:        # nearest first when the user's position is known; else the largest
            found.sort(key=lambda f: -float(f["mask_array"].mean()))
        found[0] = _recentre(server, preset, found[0], request, run, tried, say)
    return found[0], tried, hits, found

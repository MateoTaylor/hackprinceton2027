"""Pointer input: the user clicked a spot in the view. Small steps, so a coordinator can call them as tools.

  highlight  SAM only: up to three outlines of the click, small to large (a part, the object, a group).
             About 0.3 s with the warm SAM process. This is what a UI shows at once.
  mark       the copy of the view the VLM sees, with a ring at the click
  ask        one VLM question: what is at the click, a box around the whole object, what is behind it,
             the instruction
  refine     SAM again: outline A = the VLM's box with the click; x1, x2 = other things the words named
  choose     SAM's most confident rung, unless A is a larger or different thing; for a removal, grown
             to take what rests on top of it
  describe   one VLM question about the chosen outline, drawn on a crop: is it an object, and its name
  recenter   the object is cut by the edge of the view: a new camera on the same panorama, centred on it

The click and every box leaving here are on the 0-1000 scale of the view; pixels inside.
"""
import math
import re

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

from edit_agent import steps
from edit_agent.find.common import box_iou, contains, mask_box, mask_iou, sam, to_1000, to_px
from edit_agent.find.prompts import DESCRIBE_SCHEMA, POINT_SCHEMA, describe_prompt, point_prompt

MARKERS = ("both", "ring", "coords")
AGREE_IOU = 0.5           # an outline and the VLM's box count as the same object above this
MAX_SHARE = 0.5           # a removal outline larger than this share of the view is a wall or floor
NEAR = 0.015              # a thin thing (a faucet, a lamp stem) may miss the click by this share of the view
INSIDE = 0.8              # outline A lies inside SAM's default when this share of it does (shade = 54% of a lamp)
_SURFACE = re.compile(r"\b(wall|walls|floor|floors|flooring|ceiling|baseboard)\s*$", re.I)
_RING = re.compile(r"\bred (circle|circular|ring|mark|outline)", re.I)


def _words(answer):
    return [answer.get("item", "")] + [answer.get("label", "")] + [b.get("label", "") for b in answer.get("boxes", [])[:1]]


def about_ring(answer):
    """The VLM described the ring drawn at the click ("a small red circle drawn on the wall"), not the
    room. Happens on busy surfaces such as a painting. Its box is then worthless."""
    return any(_RING.search(w) for w in _words(answer))


_HEAD = re.compile(r"\s*(?:[,;]|\b(?:with|on|in|at|behind|near|next to|under|above|below|beside)\b)", re.I)
_AND = re.compile(r"\s+and\s+", re.I)


def heads(words):
    """The thing a description is about: the words before "with", "on", a comma and the like, with and
    without cutting at "and" ("white wall and door" -> "white wall"; "white and grey wall" stays)."""
    first = _HEAD.split(words.strip(" ."), maxsplit=1)[0]
    return {first, _AND.split(first, maxsplit=1)[0]}


def surface(answer):
    """True when a removal click is on bare wall, floor or ceiling. The 8B model answers found=true for
    "white wall"; the words give it away. Only the head counts: "white wall with abstract painting" is
    a wall, "painting on white wall" is not, and "wall art" or "floor lamp" do not end in the word."""
    return (answer.get("kind", "remove") == "remove" and not about_ring(answer)
            and any(_SURFACE.search(h) for w in _words(answer) for h in heads(w)))


def highlight(view, point, run, lock=True):
    """SAM's outlines of the click, small to large, without slivers and near-copies."""
    size = Image.open(view).size
    out, info = sam(view, [{"name": "click", "points": [to_px(point, size)], "labels": [1], "multimask": True}],
                    run, tag="highlight", lock=lock)
    ladder = []
    for c in out["click"]:
        if c["box"] is None or c["score"] < 0.1 or c["area"] < 0.0005 * size[0] * size[1]:
            continue
        if any(mask_iou(c["mask"], k["mask"]) > 0.9 for k in ladder):
            continue
        ladder.append(c)
    for i, c in enumerate(ladder):
        c["name"] = f"c{i}"
    return ladder, info


def default(ladder, point, size, kind="remove"):
    """SAM's own pick when there is nothing else to go by: the outline it scores highest. That is
    usually the most specific one (the lamp shade, the table without the lamp); a UI grows it by
    stepping up the ladder. "Largest it is sure of" grabbed the lamp with its table on a table click."""
    ok = [c for c in ladder if usable(c, point, size, kind)]
    return max(ok, key=lambda c: c["score"]) if ok else None


def usable(c, point, size, kind="remove", tol=3):
    share = c["area"] / (size[0] * size[1])
    return contains(c["mask"], to_px(point, size), tol) and (kind == "change" or share <= MAX_SHARE)


def mark(view, point, run, marker="both"):
    """A ring around the click, on a copy. The view the edit side gets stays clean."""
    img = Image.open(view).convert("RGB")
    if marker in ("both", "ring"):
        x, y = to_px(point, img.size)
        r = max(8, round(0.025 * max(img.size)))
        d = ImageDraw.Draw(img)
        d.ellipse([x - r - 2, y - r - 2, x + r + 2, y + r + 2], outline=(255, 255, 255), width=7)
        d.ellipse([x - r, y - r, x + r, y + r], outline=(255, 0, 0), width=3)
    out = run / "marked.jpg"
    img.save(out, quality=92)
    return out


def ask(server, marked, point, request, preset, marker="both"):
    """The VLM's reading of the click: {found, item, kind, boxes, behind, instruction}, boxes 0-1000."""
    return steps.look(server, preset, [marked], point_prompt(point, request, marker), POINT_SCHEMA)


def refine(view, point, answer, run, lock=True):
    """SAM with the VLM's boxes: A = first box plus the click; x1, x2, ... = the other boxes alone."""
    size = Image.open(view).size
    boxes = answer["boxes"] if answer.get("found") else []
    if not boxes:
        return {}, {}
    jobs = [{"name": "A", "box": steps.to_pixels(boxes[0]["bbox_2d"], size), "points": [to_px(point, size)],
             "labels": [1]}]
    jobs += [{"name": f"x{i}", "box": steps.to_pixels(b["bbox_2d"], size)} for i, b in enumerate(boxes[1:], 1)]
    out, info = sam(view, jobs, run, tag="refine", lock=lock)
    result = {}
    for name, cands in out.items():
        if cands and cands[0]["box"]:
            result[name] = {**cands[0], "name": name}
    return result, info


def choose(ladder, refined, point, answer, size):
    """Which outline to hand over and why: (outline or None, reason, record of every outline).

    SAM's most confident outline of the click is the default. Outline A (SAM inside the VLM's box)
    replaces it only when A is not inside it: the VLM saw a larger thing (the lamp, not its shade) or
    a different one (a thin faucet in front of a door). When A lies inside the default, the VLM boxed
    only the spot under the ring (a patch of a painting), and the default stands."""
    kind = answer.get("kind", "remove")
    vlm_box = steps.to_pixels(answer["boxes"][0]["bbox_2d"], size) if answer.get("found") and answer["boxes"] else None
    A = refined.get("A")
    near = round(NEAR * max(size))
    record = {c["name"]: {"share": round(c["area"] / (size[0] * size[1]), 4), "sam_score": c["score"],
                          "contains_click": contains(c["mask"], to_px(point, size)), "box_px": c["box"],
                          "iou_vlm_box": round(box_iou(c["box"], vlm_box), 2) if vlm_box else None}
              for c in ladder + ([A] if A else [])}
    pick, reason = default(ladder, point, size, kind), "sam"
    if A is not None and record["A"]["iou_vlm_box"] >= AGREE_IOU and usable(A, point, size, kind, tol=near):
        inside = (A["mask"] & pick["mask"]).sum() / max(1, A["area"]) if pick else 0.0
        record["A"]["inside_default"] = round(float(inside), 2)
        if inside < INSIDE:
            pick, reason = A, "vlm"
        else:
            reason = "sam, holds the VLM's box"
    if pick is None:
        return None, "no outline contains the click", record
    if kind == "remove":
        grown = grow_up(pick, [c for c in ladder if usable(c, point, size, kind)])
        if grown is not pick:
            pick, reason = grown, f"{reason}, grown to {grown['name']} (things on top go with it)"
    return pick, reason, record


def grow_up(pick, ladder):
    """For a removal: a larger rung that holds the outline and adds only what rests on top of it.

    Things on top go with a removal (the lamp on a table, the shade on a lamp base), but the 8B VLM
    names them without boxing them. SAM's ladder already has the bigger outline; this picks it when
    what it adds lies above the outline's top quarter, centred over it (not a neighbour beside it),
    and it reaches no lower than the outline does."""
    x0, y0, x1, y1 = pick["box"]
    w, h = x1 - x0, y1 - y0
    best = pick
    for c in sorted(ladder, key=lambda c: c["area"]):
        if c["area"] <= best["area"] or (c["mask"] & pick["mask"]).sum() < 0.9 * pick["area"]:
            continue
        added = c["mask"] & ~pick["mask"]
        if added.sum() < 0.1 * pick["area"]:
            continue
        ys, xs = np.nonzero(added)
        above = (ys < y0 + 0.25 * h).mean() >= 0.7 and c["box"][3] <= y1 + 0.05 * h
        centred = abs(xs.mean() - (x0 + x1) / 2) <= 0.15 * w     # a jar beside the clicked one sat at 0.25
        if above and centred:
            best = c
    return best


def describe_crop(view, mask, run):
    """A crop around the outline with room for its surroundings, the outline drawn in red and the
    rest darkened. Without the darkening, a wall outline with a sofa in front got named "sofa"."""
    img = Image.open(view).convert("RGB")
    x0, y0, x1, y1 = mask_box(mask)
    mx, my = max(40, (x1 - x0) // 2), max(40, (y1 - y0) // 2)
    box = [max(0, x0 - mx), max(0, y0 - my), min(img.width, x1 + mx), min(img.height, y1 + my)]
    m = Image.fromarray(mask.astype(np.uint8) * 255)
    width = max(2, round(max(img.size) / 300))
    edge = np.asarray(m.filter(ImageFilter.MaxFilter(2 * width + 1))) > 0
    edge &= ~(np.asarray(m.filter(ImageFilter.MinFilter(3))) > 0)
    a = np.asarray(img).copy()
    a[~mask] = (a[~mask] * 0.4).astype(np.uint8)
    a[edge] = (255, 0, 0)
    out = run / "describe_crop.jpg"
    Image.fromarray(a).crop(box).save(out, quality=92)
    return out


def describe(server, crop, request, preset):
    return steps.look(server, preset, [crop], describe_prompt(request), DESCRIBE_SCHEMA, max_tokens=400)


def target_from(pick, size, answer=None, described=None, extras=None):
    """The `target` for first_pass and the mask to hand over. Boxes come from SAM's outlines, so they
    agree with the mask. `described` (the VLM named this outline) wins over `answer` (the VLM's reading
    of the click); `extras` are outlines of other things the user's words named."""
    union = pick["mask"].copy()
    boxes = [{"label": (described or answer["boxes"][0])["label"], "bbox_2d": to_1000(pick["box"], size)}]
    for i, b in enumerate((answer or {}).get("boxes", [])[1:], 1):
        extra = (extras or {}).get(f"x{i}")
        if extra is not None and (extra["mask"] & ~union).sum() > 0.2 * extra["area"]:   # not inside already
            union |= extra["mask"]
            boxes.append({"label": b["label"], "bbox_2d": to_1000(extra["box"], size)})
    words = described if described and len(boxes) == 1 else answer      # the answer names every object
    return {"item": words["item"], "kind": words["kind"], "behind": words["behind"],
            "instruction": words["instruction"], "boxes": boxes}, union


def _ray(cam, x, y):
    d = cam.f + ((x - cam.w / 2) / cam.focal) * cam.r - ((y - cam.h / 2) / cam.focal) * cam.u
    return d / np.linalg.norm(d)


def recenter(scan, size, mask, point, fov=None):
    """A camera on the same panorama that looks at the middle of the outline, with the same field of
    view unless `fov` is given (a zoom). Returns the new scan view and where the click lands in it (0-1000)."""
    from pano import Camera, Scan
    s = Scan(scan["model"])
    pos = s.position(scan["pano"])
    cam = Camera.from_angles(pos, scan.get("yaw", 0), scan.get("pitch", 0), scan.get("fov", 75), *size)
    ys, xs = np.nonzero(mask)
    d = _ray(cam, xs.mean() + 0.5, ys.mean() + 0.5)
    yaw = math.degrees(math.atan2(d[1], d[0])) % 360
    pitch = max(-80.0, min(80.0, math.degrees(math.asin(d[2]))))
    new = {**scan, "yaw": round(yaw, 1), "pitch": round(pitch, 1), "fov": round(fov or scan.get("fov", 75), 1)}
    cam2 = Camera.from_angles(pos, new["yaw"], new["pitch"], new["fov"], *size)
    click = _ray(cam, *to_px(point, size))
    x, y, _ = cam2.project(pos + click)
    return new, to_1000([float(x), float(y)], size)

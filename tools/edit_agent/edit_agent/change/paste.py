"""The paste rule for a change: the image model's picture goes back inside the thing only.

A removal pastes a mask grown past the item, plus the item's shadow (steps.paste). A change must not:
the image model redraws the whole view, and a grown paste brings back what it changed nearby (in the
qwen_test sofa_pillows case it recoloured the painting and the grey pillows). So:
- the paste area is the thing's mask (plus its new outline when the form may change a little);
- a recolour pastes only the pixels of the named colour (colour.region), so other parts stay;
- the photo's own shadows and glows stay; checks.py reports where the model changed them;
- the tone match is measured on the picture away from the thing. Measured at the thing's edge, the
  blur would carry the new colour into the gap and pull the result back toward the old colour. It is
  held within TONE_BAND of its median, so the model's relighting next to the thing is not carried in.
"""
import numpy as np
from PIL import Image, ImageFilter

from edit_agent import metrics
from edit_agent.change import colour
from run_qwen import membrane

FORM_GROW = 0.10          # a new outline may reach this share of the old box's size past the old box
TONE_BAND = 15.0          # levels (0-255) the tone match may differ from its median drift


def _bool(path):
    return np.asarray(Image.open(path).convert("L")) > 127


def save_mask(mask, path):
    Image.fromarray((np.clip(mask, 0, 1) * 255).astype(np.uint8) if mask.dtype != bool
                    else mask.astype(np.uint8) * 255).save(path)
    return path


def grown_box(item, size, share=FORM_GROW):
    ys, xs = np.nonzero(item)
    x0, y0, x1, y1 = xs.min(), ys.min(), xs.max() + 1, ys.max() + 1
    dx, dy = share * (x1 - x0), share * (y1 - y0)
    return [int(max(0, x0 - dx)), int(max(0, y0 - dy)), int(min(size[0], x1 + dx)), int(min(size[1], y1 + dy))]


def new_outline(raw, item, run):
    """SAM's outline of the thing in the image model's picture, for a change of form. Prompted with the
    old box grown by FORM_GROW and the old mask's inner points; the candidate most like the old mask wins.
    Returns (outline or None, info)."""
    from edit_agent.find.common import sam
    from lift import shrink, spread
    size = item.shape[::-1]
    fitted = run / "raw_fitted.png"                     # the image model may return another size (736 for 720)
    Image.open(raw).convert("RGB").resize(size, Image.LANCZOS).save(fitted)
    raw = fitted
    box = grown_box(item, size)
    inner = shrink(item, 4)
    ys, xs = np.nonzero(inner if inner.any() else item)
    pts = spread(np.stack([xs, ys], 1) + 0.5, 4)
    found, info = sam(raw, [{"name": "after", "box": box, "points": pts.round(1).tolist(), "labels": [1] * len(pts),
                             "multimask": True}], run, tag="form")
    best, best_iou = None, 0.0
    for cand in found["after"]:
        m = cand["mask"]
        iou = float((m & item).sum() / max(1, (m | item).sum()))
        if iou > best_iou:
            best, best_iou = m, iou
    if best is None:
        return None, {**info, "form_iou": 0.0}
    inside = np.zeros_like(best)
    inside[box[1]:box[3], box[0]:box[2]] = True
    beyond = float((best & ~inside).sum() / max(1, best.sum()))
    save_mask(best, run / "outline_after.png")
    return best & inside, {**info, "form_iou": round(best_iou, 3), "form_beyond": round(beyond, 3), "form_box": box}


def paste(view, raw, mask, target, preset, run, outline=None):
    """Same return shape as steps.paste: (edited path, paste mask path, info)."""
    photo = Image.open(view).convert("RGB")
    out = Image.open(raw).convert("RGB").resize(photo.size, Image.LANCZOS)
    item = _bool(mask)
    change = target["change"]
    area = item | outline if outline is not None else item.copy()
    weight = area.astype(np.float32)
    info = {}
    if change["style"] == "recolor":
        weight, cinfo = colour.region(photo, item, change["from"])
        info.update(cinfo)
        save_mask(weight, run / "colour_mask.png")
    shift = 0.0
    if preset.tone_match:
        reach = max(6, round(0.015 * max(photo.size)))        # past the blur (radius 3) and the soft edge
        near = metrics.grown(area, reach)
        if near.mean() < 0.85:
            blur = ImageFilter.GaussianBlur(3)
            gap = np.asarray(photo.filter(blur), np.float32) - np.asarray(out.filter(blur), np.float32)
            # The tone match corrects the image model's drift over the whole picture. Where it relit the
            # room next to the thing (a dark door darkens the hall), the gap is that light, not drift, and
            # carried inside it undid the change (door-walnut: +135 levels, a grey door). So the gap is
            # held to a band around its median away from the thing.
            med = np.median(gap[~near], axis=0)
            gap = np.clip(gap, med - TONE_BAND, med + TONE_BAND)
            fix = membrane(gap, near)
            out = Image.fromarray(np.clip(np.asarray(out, np.float32) + fix, 0, 255).astype(np.uint8))
            shift = round(float(np.abs(fix[area]).mean()), 2)
    soft = Image.fromarray((np.clip(weight, 0, 1) * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(1))
    edited, paste_mask = run / "edited.png", run / "paste_mask.png"
    Image.composite(out, photo, soft).save(edited)
    save_mask(weight > 0.5, paste_mask)
    ys, xs = np.nonzero(weight > 0.5)
    box = [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1] if len(xs) else None
    return edited, paste_mask, {"tone_shift": shift, "paste_box": box,
                                "paste_share": round(float((weight > 0.5).mean()), 4), **info}

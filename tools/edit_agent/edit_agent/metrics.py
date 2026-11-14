"""Numbers about an edit, computed from pixels with numpy. No model runs here.

  drift_outside   how much the image model changed pixels away from the item (it redraws the whole picture)
  change_inside   how much the finished edit differs from the original where the item was
  border_step     how much the tone steps at the paste border, along the worst tenth of the border
  effect_share    how much of the picture is the item's effect: its shadow, reflection or glow, found from
                  where the image model changed the smooth brightness in one piece with the item
  effect_left     how much of that effect lies outside the pasted area, so is still in the picture
"""
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

import edit_agent.config  # noqa: F401  puts tools/qwen_test on the import path
from run_qwen import grow_mask

LUMA = np.array([0.299, 0.587, 0.114], np.float32)
EFFECT_PX = 256                                   # long side of the copy the effect search runs on
_HEAT = np.array([[0, 0, 0], [40, 20, 110], [150, 30, 120], [230, 80, 50], [250, 180, 40], [255, 255, 200]], np.float32)


def grown(mask, radius):
    """Dilate a boolean mask by `radius` pixels."""
    return np.asarray(grow_mask(Image.fromarray(mask.astype(np.uint8) * 255), radius)) > 0


def shrunk(mask, radius):
    return ~grown(~mask, radius)


def _mean(diff, where):
    return round(float(diff[where].mean()), 2) if where.any() else 0.0


def _box_blur(a, r, axis):
    pad = [(0, 0)] * a.ndim
    pad[axis] = (r + 1, r)
    total = np.cumsum(np.pad(a, pad, mode="edge"), axis=axis, dtype=np.float64)
    n = a.shape[axis]
    window = np.take(total, np.arange(2 * r + 1, 2 * r + 1 + n), axis=axis) - np.take(total, np.arange(n), axis=axis)
    return (window / (2 * r + 1)).astype(np.float32)


def smooth(a, r):
    """Blur a float array. Three box blurs are close to a Gaussian (Pillow cannot blur float images)."""
    for _ in range(3):
        a = _box_blur(_box_blur(a, r, 0), r, 1)
    return a


def change_field(view, raw, item):
    """The smooth brightness change the image model made (raw minus view), with its overall drift taken out.

    The model redraws every texture, so pixel differences are noise everywhere; a shadow or a glow is a
    smooth change and survives the blur. The blur goes around the item, not through it, so the item's
    own disappearance does not leak into its surroundings. Also returns the field's noise far from the item.
    """
    long_side = max(view.size)
    keep = ~grown(item, max(1, round(0.004 * long_side)))
    change = (np.asarray(raw, np.float32) - np.asarray(view, np.float32)) @ LUMA
    r = max(2, round(0.012 * long_side))
    weight = smooth(keep.astype(np.float32), r)
    field = np.where(weight > 0.05, smooth(change * keep, r) / np.maximum(weight, 0.05), 0.0)
    far = ~grown(item, round(0.25 * long_side))
    if far.mean() < 0.2:
        far = keep
    field = field - np.median(field[far])
    return field, 1.4826 * float(np.median(np.abs(field[far])))


def effect_region(view, raw, item, limits):
    """Where the image model changed the brightness in one piece with the item: its shadow, reflection or glow.

    Grows outwards from the item through the changed pixels, so a long shadow is followed to its end
    and changes elsewhere in the picture are left out. Returns the region (outside the item) and numbers.
    The search runs on a small copy: the field is smooth, and growing a mask a long way is slow at full size.
    """
    full = view.size
    scale = min(1.0, EFFECT_PX / max(full))
    size = (max(1, round(full[0] * scale)), max(1, round(full[1] * scale)))
    small_item = np.asarray(Image.fromarray(item.astype(np.uint8) * 255).resize(size, Image.BOX)) > 0
    field, noise = change_field(view.resize(size, Image.BOX), raw.resize(size, Image.BOX), small_item)
    limit = max(limits.effect_sigmas * noise, limits.effect_min)
    strong = np.abs(field) > limit
    seed = grown(small_item, max(2, round(0.012 * max(size))))
    reach = seed
    for _ in range(400):
        wider = (grown(reach, 2) & strong) | seed
        if (wider == reach).all():
            break
        reach = wider
    small = reach & strong & ~small_item
    region = (np.asarray(Image.fromarray(small.astype(np.uint8) * 255).resize(full, Image.NEAREST)) > 0) & ~item
    info = {"effect_share": round(float(region.mean()), 4), "effect_limit": round(limit, 1)}
    if region.any():
        info["effect_sign"] = round(float(field[small].mean()), 1)      # above 0: the model made it brighter (a shadow went)
        ys, xs = np.nonzero(region)
        info["effect_box"] = [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1]
    if region.mean() > limits.effect_max_share:
        info["effect_capped"] = 1
        region = np.zeros_like(region)
    return region, info


def heat(values, top):
    """Colour-map an array: black at 0, through purple, red and orange, to pale yellow at `top`."""
    t = np.clip(values / top, 0, 1) * (len(_HEAT) - 1)
    low = np.floor(t).astype(int).clip(0, len(_HEAT) - 2)
    part = (t - low)[..., None]
    return Image.fromarray((_HEAT[low] * (1 - part) + _HEAT[low + 1] * part).astype(np.uint8))


def change_map(before, after, gain=4.0):
    """The absolute difference between two pictures, pixel by pixel, amplified and colour-mapped."""
    diff = np.abs(np.asarray(before.convert("RGB"), np.float32) - np.asarray(after.convert("RGB"), np.float32))
    return heat(diff.mean(axis=2) * gain, 255.0)


def measure(view_path, raw_path, edited_path, mask_path, paste_mask_path, effect_path=None):
    view = Image.open(view_path).convert("RGB")
    raw = Image.open(raw_path).convert("RGB").resize(view.size, Image.LANCZOS)
    edited = Image.open(edited_path).convert("RGB")
    item = np.asarray(Image.open(mask_path).convert("L")) > 127
    paste = np.asarray(Image.open(paste_mask_path).convert("L")) > 127
    long_side = max(view.size)

    def pixels(img):
        return np.asarray(img, np.float32)

    near = grown(item, round(0.02 * long_side))
    scores = {
        "drift_outside": _mean(np.abs(pixels(view) - pixels(raw)), ~near),
        "change_inside": _mean(np.abs(pixels(view) - pixels(edited)), item),
        "border_step": 0.0,
        "mask_share": round(float(item.mean()), 4),
        "paste_share": round(float(paste.mean()), 4),
    }
    # A visible paste border is a tone step right at the border. The paste matches tones there, so a
    # clean one starts from nothing and rises slowly, however much the edit changes further in (a
    # lamp's glow going from a wall). The band is thin and close: 0.3 to 1.2 % of the long side inside
    # the border. A border often shows along part of its length only (where it crosses a floor the
    # model relit), so the number is the 90th percentile, not the mean.
    blur = ImageFilter.GaussianBlur(3)                       # compare tones, not the texture the model redrew
    band = (shrunk(paste, max(1, round(0.003 * long_side))) & ~shrunk(paste, max(2, round(0.012 * long_side)))
            & ~near)
    if band.any():
        step = np.abs((pixels(edited.filter(blur)) - pixels(view.filter(blur))) @ LUMA)
        scores["border_step"] = round(float(np.percentile(step[band], 90)), 2)
        ys, xs = np.nonzero(band & (step >= scores["border_step"]))
        scores["border_box"] = [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1]
    if effect_path and Path(effect_path).exists():           # the part of the item's effect that the paste kept
        left = (np.asarray(Image.open(effect_path).convert("L")) > 127) & ~paste
        scores["effect_left"] = round(float(left.mean()), 4)
        if left.any():
            ys, xs = np.nonzero(left)
            scores["effect_left_box"] = [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1]
    return scores


def flags(scores, limits, region=None):
    """The few numeric checks that are worth a second pass. Returns (kind, severity, evidence, region)."""
    out = []
    if scores["drift_outside"] > limits.wrong_picture_drift:
        out.append(("wrong_picture", 3, f"the image model changed the whole picture (drift {scores['drift_outside']}; "
                                        "a clean edit measures 9 to 19)", None))
    if scores["change_inside"] < limits.unchanged_inside:
        out.append(("object_remains", 3, f"the masked area barely changed (mean change {scores['change_inside']})",
                    region))
    if scores["border_step"] > limits.border_step:
        out.append(("visible_seam", 2, f"the tone steps by {scores['border_step']} at the paste border, along its "
                                       "worst tenth (a clean paste measures 4 to 8)", scores.get("border_box") or region))
    if scores.get("effect_left", 0) > limits.effect_left:
        shadow = scores.get("effect_sign", 0) > 0
        what = "removed a shadow" if shadow else "took away light"
        out.append(("shadow_left" if shadow else "light_left", 2,
                    f"the image model {what} here, but it lies outside the pasted area and is still in the picture "
                    f"({scores['effect_left']:.1%} of the picture)", scores.get("effect_left_box")))
    return out

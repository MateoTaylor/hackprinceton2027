"""Colours by name, and the recolour guardrail: the part of a thing that has the named colour.

"Change the blue pillows to red" pastes the image model's red only where the photo's pillow is blue,
so a grey pattern or piping stays the photo's own pixels. Colours are compared in CIELAB: hue is the
angle of (a*, b*), chroma its length. Shading changes lightness and chroma but keeps the hue, so a
fold in a blue pillow is still blue.
"""
import re
from collections import deque

import numpy as np
from PIL import Image, ImageFilter

# Swatches for colour words (sRGB). Their hue and chroma are computed below.
SWATCHES = {
    "red": (200, 35, 35), "maroon": (110, 25, 35), "burgundy": (120, 25, 45), "coral": (240, 120, 100),
    "orange": (230, 120, 30), "rust": (170, 80, 40), "brown": (120, 75, 40), "tan": (190, 150, 100),
    "beige": (210, 190, 150), "cream": (240, 230, 200), "gold": (200, 160, 50), "mustard": (200, 160, 30),
    "yellow": (230, 200, 40), "olive": (110, 110, 40), "green": (40, 150, 60), "sage": (150, 170, 130),
    "mint": (150, 220, 180), "teal": (0, 128, 128), "turquoise": (60, 200, 200), "aqua": (80, 210, 210),
    "blue": (40, 70, 200), "navy": (25, 35, 95), "purple": (120, 50, 150), "violet": (140, 80, 200),
    "lavender": (180, 160, 220), "pink": (230, 120, 170), "magenta": (200, 40, 150),
    "white": (240, 240, 240), "silver": (190, 190, 190), "grey": (128, 128, 128), "gray": (128, 128, 128),
    "charcoal": (60, 60, 60), "black": (20, 20, 20),
}
CHROMATIC = 15.0          # a swatch with less chroma than this is grey, white or black


def to_lab(rgb):
    """sRGB (..., 3) uint8 or float 0-255 -> CIELAB (D65), float32."""
    c = np.asarray(rgb, np.float32) / 255.0
    c = np.where(c > 0.04045, ((c + 0.055) / 1.055) ** 2.4, c / 12.92)
    xyz = c @ np.array([[0.4124, 0.2126, 0.0193], [0.3576, 0.7152, 0.1192], [0.1805, 0.0722, 0.9505]], np.float32)
    xyz /= np.array([0.9505, 1.0, 1.089], np.float32)
    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16 / 116)
    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])], -1)


def hue_chroma(lab):
    return np.degrees(np.arctan2(lab[..., 2], lab[..., 1])) % 360, np.hypot(lab[..., 1], lab[..., 2])


def hue_gap(a, b):
    d = np.abs(np.asarray(a) - np.asarray(b)) % 360
    return np.minimum(d, 360 - d)


_LAB = {w: to_lab(np.array(rgb, np.float32)) for w, rgb in SWATCHES.items()}
_WORD = re.compile(r"\b(" + "|".join(sorted(SWATCHES, key=len, reverse=True)) + r")(?:ish)?\b", re.I)
_SHADE = re.compile(r"\b(light|dark|pale|deep|bright|dusty|muted|navy|sky|royal)\b", re.I)


def named(words):
    """The swatch for a colour phrase ("dark teal" -> teal), or None if it names no colour."""
    m = _WORD.search(words or "")
    return None if m is None else m.group(1).lower()


def strip_colours(name):
    """A thing's name without its colour words ("teal throw pillows" -> "throw pillows")."""
    return re.sub(r"\s+", " ", _SHADE.sub("", _WORD.sub("", name or ""))).strip(" ,-")


def describe_word(word):
    """(hue, chroma, lightness) of a colour word's swatch."""
    lab = _LAB[word]
    h, c = hue_chroma(lab)
    return float(h), float(c), float(lab[0])


def _holes(on, item, most):
    """Fill the gaps in `on` that lie inside the item, touch neither the item's edge nor anything
    outside it, and are at most `most` pixels: specks of shadow, not a pattern."""
    out = on.copy()
    gap = item & ~on
    seen = np.zeros_like(gap)
    h, w = gap.shape
    for y0, x0 in zip(*np.nonzero(gap)):
        if seen[y0, x0]:
            continue
        seen[y0, x0] = True
        comp, queue, edge = [(y0, x0)], deque([(y0, x0)]), False
        while queue:
            y, x = queue.popleft()
            for yy, xx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
                if not (0 <= yy < h and 0 <= xx < w) or not item[yy, xx]:
                    edge = True
                elif gap[yy, xx] and not seen[yy, xx]:
                    seen[yy, xx] = True
                    comp.append((yy, xx))
                    queue.append((yy, xx))
        if not edge and len(comp) <= most:
            ys, xs = zip(*comp)
            out[list(ys), list(xs)] = True
    return out


def region(photo, item, word):
    """Weights 0-1 over the picture: 1 where the photo's thing has the colour `word`.

    The thing's own version of the colour is found first (the user's "blue" can be the photo's teal):
    the pixels within 60 degrees of hue of the word, or, if there are too few, the thing's most
    common hue. A pixel then counts by its hue gap to that and by having at least a quarter of its
    chroma. Returns (weights, info).
    """
    lab = to_lab(np.asarray(photo.convert("RGB")))
    hue, chroma = hue_chroma(lab)
    h_in, c_in, l_in = hue[item], chroma[item], lab[..., 0][item]
    word = named(word)
    info = {"from_word": word}
    if word is None:
        return item.astype(np.float32), {**info, "colour_rule": "none: the request names no colour"}
    wh, wc, wl = describe_word(word)
    if wc >= CHROMATIC:
        near = (c_in >= 8) & (hue_gap(h_in, wh) < 60)
        if near.sum() >= 0.05 * item.sum():
            pick = near
        else:                                                  # the thing's most common hue
            bins = np.bincount((h_in[c_in >= 8] // 10).astype(int), weights=c_in[c_in >= 8], minlength=36)
            peak = int(np.argmax(np.convolve(np.r_[bins[-1], bins, bins[0]], [1, 2, 1], "valid"))) * 10 + 5
            pick = (c_in >= 8) & (hue_gap(h_in, peak) < 30)
        angles = np.radians(h_in[pick])
        h0 = float(np.degrees(np.arctan2((np.sin(angles) * c_in[pick]).sum(), (np.cos(angles) * c_in[pick]).sum())) % 360)
        c0 = float(np.median(c_in[pick])) if pick.any() else wc
        w = np.clip((chroma - 0.25 * c0) / (0.25 * c0), 0, 1) * np.clip(1 - (hue_gap(hue, h0) - 25) / 20, 0, 1)
        info.update(hue=round(h0, 1), chroma=round(c0, 1))
    else:                                                      # grey, white, black: low chroma, near a lightness
        low = (c_in < 8) & (np.abs(l_in - wl) < 30)
        l0 = float(np.median(l_in[low])) if low.any() else wl
        w = np.clip(1 - (chroma - 6) / 6, 0, 1) * np.clip(1 - (np.abs(lab[..., 0] - l0) - 15) / 10, 0, 1)
        info.update(lightness=round(l0, 1))
    w = np.where(item, w, 0).astype(np.float32)
    on = _holes(w > 0.5, item, most=max(16, int(2e-5 * item.size)))
    soft = np.maximum(w, on.astype(np.float32))
    soft = np.asarray(Image.fromarray((soft * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.8)),
                      np.float32) / 255 * item
    info["colour_share"] = round(float((soft > 0.5).sum() / max(1, item.sum())), 3)
    return soft, info


def landed(result, where, to_word, from_info):
    """Did the asked colour land where the old one was? Returns numbers for the checks."""
    lab = to_lab(np.asarray(result.convert("RGB")))[where]
    if not len(lab):
        return {}
    hue, chroma = hue_chroma(lab)
    out = {}
    word = named(to_word)
    if word is not None:
        th, tc, tl = describe_word(word)
        if tc >= CHROMATIC:
            angles = np.radians(hue)
            mean = float(np.degrees(np.arctan2((np.sin(angles) * chroma).sum(), (np.cos(angles) * chroma).sum())) % 360)
            out.update(new_hue=round(mean, 1), hue_off=round(float(hue_gap(mean, th)), 1),
                       new_chroma=round(float(np.median(chroma)), 1))
        else:
            out.update(new_chroma=round(float(np.median(chroma)), 1),
                       light_off=round(float(abs(np.median(lab[:, 0]) - tl)), 1))
    if "hue" in from_info:                                     # pixels that still have the old colour
        old = (hue_gap(hue, from_info["hue"]) < 25) & (chroma >= 0.25 * from_info["chroma"])
        out["old_left"] = round(float(old.mean()), 3)
    return out

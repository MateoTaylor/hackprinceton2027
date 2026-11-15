"""Scouting: where did the edit change the picture in a way the request did not ask for?

The image model redraws the whole view. The paste copies its picture back near the item and over the
item's shadow or glow, so inside that area other things can change too: a baseboard goes with a lamp,
a neighbour is cut, something new is drawn. This finds those places from the two pictures, without a
model, as boxes for a closer look (a VLM question on a crop, or putting the original back).

It compares edge energy, not pixels. The model redraws every texture, so pixels differ everywhere;
a line or an outline that is gone, or a new one, shows as a drop or a rise in the local amount of edge.

What it cannot tell apart by itself: the edge of a shadow that was rightly removed and a thin part
that was wrongly removed. Both are edges that vanished next to the item. So a region is a candidate,
not a verdict. What it cannot see at all: something the model left in (no change there), and anything
inside the item's own outline (there is no "before" to compare with).

  python -m edit_agent.scout RUN_FOLDER [RUN_FOLDER ...] [--out FOLDER]
"""
import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

from edit_agent import metrics
from edit_agent.config import Limits

PX = 256                                          # blobs are found on a copy this size


def edge_energy(img):
    """The local amount of edge: gradient size of the slightly blurred brightness, averaged over a small window."""
    long_side = max(img.size)
    lum = np.asarray(img.filter(ImageFilter.GaussianBlur(0.002 * long_side)), np.float32) @ metrics.LUMA
    gy, gx = np.gradient(lum)
    return metrics.smooth(np.hypot(gx, gy), max(2, round(0.006 * long_side)))


def blobs(mask):
    """The connected pieces of a small boolean array."""
    todo, out = mask.copy(), []
    h, w = mask.shape
    for y, x in np.argwhere(mask):
        if not todo[y, x]:
            continue
        piece, stack = np.zeros_like(mask), [(y, x)]
        todo[y, x] = False
        while stack:
            cy, cx = stack.pop()
            piece[cy, cx] = True
            for ny, nx in ((cy - 1, cx), (cy + 1, cx), (cy, cx - 1), (cy, cx + 1)):
                if 0 <= ny < h and 0 <= nx < w and todo[ny, nx]:
                    todo[ny, nx] = False
                    stack.append((ny, nx))
        out.append(piece)
    return out


def find(view, edited, item, paste, limits=Limits()):
    """Candidate regions outside the item where edges vanished or appeared, strongest first.

    Each is {"kind": "edges_lost" or "edges_new", "box": [x0, y0, x1, y1] in pixels, "peak", "share"}.
    `peak` is the largest change in edge energy, `share` the part of the picture above the limit.
    """
    w, h = view.size
    long_side = max(w, h)
    before, after = edge_energy(view), edge_energy(edited)
    # The item's own outline goes with it. The ring is thin: a wider one (3 %) hid a vent cut next to a fan blade.
    where = paste & ~metrics.grown(item, max(1, round(limits.scout_ring * long_side)))
    lost = np.clip(before - after, 0, None) * where
    new = np.clip(after - before, 0, None) * where
    hot = np.maximum(lost, new) > limits.scout_edge
    if not hot.any():
        return []
    size = (max(1, round(w * PX / long_side)), max(1, round(h * PX / long_side)))
    small = np.asarray(Image.fromarray(hot.astype(np.uint8) * 255).resize(size, Image.BOX)) > 0
    joined = metrics.grown(small, max(1, round(0.02 * PX)))               # pieces of one line count as one
    out = []
    for piece in blobs(joined):
        full = (np.asarray(Image.fromarray(piece.astype(np.uint8) * 255).resize((w, h), Image.NEAREST)) > 0) & hot
        if full.mean() < limits.scout_min_share:
            continue
        ys, xs = np.nonzero(full)
        gone, came = float(lost[full].sum()), float(new[full].sum())
        out.append({"kind": "edges_lost" if gone >= came else "edges_new",
                    "box": [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1],
                    "peak": round(float(max(lost[full].max(), new[full].max())), 1),
                    "share": round(float(full.mean()), 4)})
    out.sort(key=lambda r: -r["peak"] * r["share"] ** 0.5)
    return out[:limits.scout_regions]


def redrawn_with(view, edited, seeds, limits=Limits()):
    """`seeds` plus every piece the model redrew that touches them.

    A neighbour the model drew a little differently (a wire table whose wires moved) has new edges next
    to lost ones. A removed shadow or removed trim has lost edges only, so it is not picked up here.
    """
    w, h = view.size
    long_side = max(w, h)
    new = edge_energy(edited) - edge_energy(view) > limits.scout_edge / 2
    both = metrics.grown(new, round(0.012 * long_side)) | seeds
    size = (max(1, round(w * PX / long_side)), max(1, round(h * PX / long_side)))
    def small(mask):
        return np.asarray(Image.fromarray(mask.astype(np.uint8) * 255).resize(size, Image.BOX)) > 0
    seed, out = small(seeds), np.zeros(size[::-1], bool)
    for piece in blobs(small(both)):
        if (piece & seed).any():
            out |= piece
    return (np.asarray(Image.fromarray(out.astype(np.uint8) * 255).resize((w, h), Image.NEAREST)) > 0) & both


def crop_box(box, size, pad=0.08, least=0.3):
    """A box around a region with room to see what it is: padded, at least `least` of the long side, inside the picture."""
    w, h = size
    long_side = max(w, h)
    cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
    half_w = max((box[2] - box[0]) / 2 + pad * long_side, least * long_side / 2)
    half_h = max((box[3] - box[1]) / 2 + pad * long_side, least * long_side / 2)
    x0, y0 = max(0, round(cx - half_w)), max(0, round(cy - half_h))
    return [x0, y0, min(w, round(cx + half_w)), min(h, round(cy + half_h))]


def load(run, edited="edited.png"):
    """The pictures of a finished run: view, edited, item mask, paste mask."""
    run = Path(run)
    return read(run / "view.png", run / edited, run / "mask.png", run / "paste_mask.png")


def read(view, edited, mask, paste_mask):
    view = Image.open(view).convert("RGB")
    edited = Image.open(edited).convert("RGB")
    item = np.asarray(Image.open(mask).convert("L").resize(view.size)) > 127
    paste = np.asarray(Image.open(paste_mask).convert("L").resize(view.size)) > 127
    return view, edited, item, paste


def picture(view, edited, regions, out, px=480):
    """Before and after with the regions boxed and numbered, then each region's crops, in one picture."""
    colours = {"edges_lost": (255, 60, 60), "edges_new": (60, 160, 255)}
    rows = [[view.copy(), edited.copy()]]
    for img in rows[0]:
        draw = ImageDraw.Draw(img)
        for n, region in enumerate(regions, 1):
            draw.rectangle(region["box"], outline=colours[region["kind"]], width=3)
            draw.text((region["box"][0] + 4, region["box"][1] + 2), str(n), fill=colours[region["kind"]])
    for region in regions:
        box = crop_box(region["box"], view.size)
        rows.append([view.crop(box), edited.crop(box)])
    sheet = Image.new("RGB", (2 * px, px * len(rows)), "black")
    for r, pair in enumerate(rows):
        for c, img in enumerate(pair):
            tile = img.copy()
            tile.thumbnail((px, px), Image.LANCZOS)
            sheet.paste(tile, (c * px, r * px))
    sheet.save(out, quality=88)
    return out


def main():
    parser = argparse.ArgumentParser(description="Find unexpected changes in finished runs.")
    parser.add_argument("runs", nargs="+")
    parser.add_argument("--out", help="folder for the pictures (default: each run's own folder)")
    args = parser.parse_args()
    for name in args.runs:
        run = Path(name)
        view, edited, item, paste = load(run)
        regions = find(view, edited, item, paste)
        out = Path(args.out) / f"{run.name}-scout.jpg" if args.out else run / "scout.jpg"
        out.parent.mkdir(parents=True, exist_ok=True)
        picture(view, edited, regions, out)
        print(run.name, json.dumps(regions))


if __name__ == "__main__":
    main()

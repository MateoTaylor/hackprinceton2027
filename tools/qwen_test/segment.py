"""Segment images with SAM 2.1. Runs in its own environment (.venv-sam) because it needs PyTorch.

  .venv-sam/Scripts/python segment.py auto --image view.png --out DIR [--min-area 0.002]
  .venv-sam/Scripts/python segment.py prompt --jobs jobs.json

auto: cut the whole image into segments without being told what to look for. Writes
  DIR/segments.npz   masks (N x H x W, bit-packed) and label (H x W, the smallest segment on each pixel)
  DIR/segments.json  per segment: id (1 = largest), area, bbox, where its number is drawn
  DIR/overlay.jpg    the image with every segment tinted, outlined and numbered (shown to the VLM)

prompt: outline one object per job, given a box and/or points on it (label 1) and off it (label 0).
jobs.json is a list of {"image", "out", "box": [x0, y0, x1, y1], "points": [[x, y]], "labels": [1, 0]};
each job writes a black and white mask to "out" and its confidence into jobs.json's "score".

The other scripts call this as a subprocess, so the model's GPU memory is freed when it exits.
"""
import argparse
import colorsys
import json
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
CHECKPOINT = HERE / "models" / "sam2.1_hiera_large.pt"
CONFIG = "configs/sam2.1/sam2.1_hiera_l.yaml"


def load():
    from sam2.build_sam import build_sam2
    device = "cuda" if torch.cuda.is_available() else "cpu"
    return build_sam2(CONFIG, str(CHECKPOINT), device=device), device


def iou(a, b):
    inter = (a & b).sum()
    return inter / max((a | b).sum(), 1)


def interior_points(label, n):
    """For each id 1..n, the pixel of its visible region farthest from the region's edge."""
    t = torch.from_numpy(label.astype(np.int32))[None, None].float()
    pad = F.pad(t, (1, 1, 1, 1), mode="replicate")
    edge = (F.max_pool2d(pad, 3, 1) != t) | (-F.max_pool2d(-pad, 3, 1) != t)
    edge[..., 0, :] = edge[..., -1, :] = edge[..., :, 0] = edge[..., :, -1] = True
    dist = torch.zeros_like(t)
    reached = edge.float()
    for step in range(1, 200):                       # chessboard distance to the nearest edge
        grown = F.max_pool2d(reached, 3, 1, 1)
        dist[(grown > 0) & (reached == 0)] = step
        if grown.min() > 0:
            break
        reached = grown
    dist = dist[0, 0].numpy()
    out = {}
    for k in range(1, n + 1):
        ys, xs = np.nonzero(label == k)
        if len(xs):
            j = int(np.argmax(dist[ys, xs]))
            out[k] = (int(xs[j]), int(ys[j]), int(dist[ys[j], xs[j]]))
    return out


def font(size):
    for name in ("arialbd.ttf", "arial.ttf", "DejaVuSans-Bold.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            pass
    return ImageFont.load_default()


def auto(args):
    from sam2.automatic_mask_generator import SAM2AutomaticMaskGenerator
    model, _ = load()
    image = np.asarray(Image.open(args.image).convert("RGB"))
    h, w = image.shape[:2]
    gen = SAM2AutomaticMaskGenerator(model, points_per_side=args.points, points_per_batch=64,
                                     pred_iou_thresh=0.7, stability_score_thresh=0.9, box_nms_thresh=0.7)
    with torch.inference_mode(), torch.autocast("cuda", dtype=torch.bfloat16, enabled=torch.cuda.is_available()):
        found = gen.generate(image)
    found = [m for m in found if m["area"] >= args.min_area * h * w and m["area"] <= args.max_area * h * w]
    found.sort(key=lambda m: -m["predicted_iou"])
    keep = []
    for m in found:                                   # drop near-copies of a better-scored mask
        if all(iou(m["segmentation"], k["segmentation"]) < 0.85 for k in keep):
            keep.append(m)
    keep.sort(key=lambda m: -m["area"])

    # label map: paint large first so each pixel ends up with the smallest segment that covers it
    label = np.zeros((h, w), np.uint16)
    for i, m in enumerate(keep):
        label[m["segmentation"]] = i + 1
    # a segment that is almost entirely covered by smaller ones has nowhere to show its number: drop it
    shown = [i for i, m in enumerate(keep) if (label == i + 1).sum() >= max(args.min_visible * m["area"], 150)]
    keep = [keep[i] for i in shown]
    label = np.zeros((h, w), np.uint16)
    for i, m in enumerate(keep):
        label[m["segmentation"]] = i + 1
    spots = interior_points(label, len(keep))

    masks = np.stack([m["segmentation"] for m in keep]) if keep else np.zeros((0, h, w), bool)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(out / "segments.npz", masks=np.packbits(masks, axis=2), label=label, shape=np.array([h, w]))

    tint = image.astype(np.float32)
    colours = [tuple(int(255 * c) for c in colorsys.hsv_to_rgb((0.11 + 0.618 * i) % 1, 0.85, 1.0)) for i in range(len(keep))]
    for i in range(len(keep)):
        tint[label == i + 1] = tint[label == i + 1] * 0.62 + np.array(colours[i], np.float32) * 0.38
    edge = np.zeros((h, w), bool)
    edge[:-1] |= label[:-1] != label[1:]
    edge[:, :-1] |= label[:, :-1] != label[:, 1:]
    tint[edge] = 255
    img = Image.fromarray(tint.astype(np.uint8))
    draw = ImageDraw.Draw(img)
    meta = []
    for i, m in enumerate(keep):
        k = i + 1
        x, y, room = spots.get(k, (0, 0, 0))
        f = font(22 if room >= 16 else 16)
        text = str(k)
        tw, th = draw.textbbox((0, 0), text, font=f)[2:]
        draw.rectangle([x - tw / 2 - 3, y - th / 2 - 3, x + tw / 2 + 3, y + th / 2 + 5], fill=(0, 0, 0), outline=colours[i])
        draw.text((x - tw / 2, y - th / 2), text, fill=(255, 255, 255), font=f)
        x0, y0, bw, bh = (int(v) for v in m["bbox"])
        meta.append({"id": k, "area": int(m["area"]), "visible_area": int((label == k).sum()),
                     "bbox": [x0, y0, x0 + bw, y0 + bh], "label_xy": [x, y],
                     "score": round(float(m["predicted_iou"]), 3)})
    img.save(out / "overlay.jpg", quality=92)
    (out / "segments.json").write_text(json.dumps(meta, indent=1), encoding="utf-8")
    print(f"{len(keep)} segments -> {out / 'overlay.jpg'}")


def prompt(args):
    from sam2.sam2_image_predictor import SAM2ImagePredictor
    model, _ = load()
    predictor = SAM2ImagePredictor(model)
    jobs_path = Path(args.jobs)
    jobs = json.loads(jobs_path.read_text(encoding="utf-8"))
    for job in jobs:
        image = np.asarray(Image.open(job["image"]).convert("RGB"))
        pts = np.array(job["points"], np.float32) if job.get("points") else None
        labels = np.array(job["labels"], np.int32) if job.get("points") else None
        box = np.array(job["box"], np.float32) if job.get("box") else None
        with torch.inference_mode(), torch.autocast("cuda", dtype=torch.bfloat16, enabled=torch.cuda.is_available()):
            predictor.set_image(image)
            masks, scores, _ = predictor.predict(point_coords=pts, point_labels=labels, box=box, multimask_output=False)
        mask = masks[0] > 0
        Image.fromarray(mask.astype(np.uint8) * 255).save(job["out"])
        job["score"] = round(float(scores[0]), 3)
        job["area"] = int(mask.sum())
        print(f"{job['out']}: score {job['score']}, {job['area']} px")
    jobs_path.write_text(json.dumps(jobs, indent=1), encoding="utf-8")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("auto")
    a.add_argument("--image", required=True)
    a.add_argument("--out", required=True)
    a.add_argument("--points", type=int, default=32, help="grid of point prompts per side")
    a.add_argument("--min-area", type=float, default=0.002, help="drop segments smaller than this share of the image")
    a.add_argument("--max-area", type=float, default=0.9)
    a.add_argument("--min-visible", type=float, default=0.15,
                   help="drop a segment when less than this share of it is not covered by smaller segments")
    p = sub.add_parser("prompt")
    p.add_argument("--jobs", required=True)
    args = ap.parse_args()
    auto(args) if args.cmd == "auto" else prompt(args)


if __name__ == "__main__":
    main()

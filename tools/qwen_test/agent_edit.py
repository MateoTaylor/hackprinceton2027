"""Agent stack: a typed request and the view you are looking at -> an edit case over every panorama.

  python -I agent_edit.py pick  --name sofa_agent --pano 1 --yaw 215 --pitch -15 --fov 75 --text "remove the couch"
  python -I agent_edit.py views --name sofa_agent
  python -I agent_edit.py all   --name sofa_agent --pano 1 --yaw 215 --pitch -15 --fov 75 --text "remove the couch"

pick   (three models, one after the other, each freed before the next loads)
  1. SAM cuts the view into segments                                  -> seed/overlay.jpg
  2. Qwen3-VL (text out) reads the request and the view, and answers with a box around the thing
     to edit plus a description that every view's prompt will share   -> seed/pick.json
  3. SAM outlines the object inside each box
  4. the outline is lifted to 3D with the mesh; for a removal, segments from step 1 that lie in
     the box and touch the item in 3D (pillows on a sofa) are added   -> seed/pick.jpg, item.npz
views  (no VLM)
  5. panoramas that see the item's voxels are chosen, a crop is framed on the item in each
  6. per view the item's pixels come from the mesh (first surface along the ray is an item voxel),
     then SAM sharpens the outline, prompted with points on and off the item
  7. the crop, mask, prefill and reference crops are written as an ordinary case (cases/<name>/)
all    pick + views, then run_qwen.py (variant `chain`), grow +100% tone-matched, paste_pano.py --export

Everything is written under cases/<name>/ and outputs/<name>/ (git-ignored).
"""
import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np
from PIL import Image, ImageDraw

from build_case import SIZE, build_target, frame, review_sheet
from lift import VoxelItem, coarse, grow, hit_points, main_parts, reproject, shrink, spread
from pano import Camera, Scan
from vlm import Server

HERE = Path(__file__).resolve().parent
SAM_PYTHON = HERE / ".venv-sam" / "Scripts" / "python.exe"
STEP = 4                # one mesh ray per STEP x STEP pixels
ATTACH = 0.25           # m: a segment this close to the item in 3D goes with it (removals only)

PICK_SCHEMA = {
    "type": "object",
    "properties": {
        "item": {"type": "string", "maxLength": 100},
        "kind": {"type": "string", "enum": ["remove", "change"]},
        "boxes": {"type": "array", "minItems": 1, "maxItems": 12, "items": {
            "type": "object",
            "properties": {"bbox_2d": {"type": "array", "items": {"type": "integer"}, "minItems": 4, "maxItems": 4},
                           "label": {"type": "string", "maxLength": 60}},
            "required": ["bbox_2d", "label"]}},
        "behind": {"type": "string", "maxLength": 300},
        "instruction": {"type": "string", "maxLength": 300},
    },
    "required": ["item", "kind", "boxes", "behind", "instruction"],
}

PICK_PROMPT = """The user asked for this edit to the photo: "{text}"

Answer with JSON:
- "item": the thing to edit, named with its colour and material, at most 12 words.
- "kind": "remove" if the thing should disappear, "change" if it stays but looks different.
- "boxes": locate every object the edit applies to. One entry per object, with "bbox_2d": [x1, y1, x2, y2] and a short "label". A box must contain the whole object, including things that sit on it and would go with it.
- "behind": one sentence describing the surfaces behind and under the thing (wall colour, floor material, baseboard), to be drawn where it is removed.
- "instruction": the user's edit rewritten as one clear sentence for an image editing model, naming the thing with its colour."""


def sam(*args):
    """Run segment.py in the SAM environment; its GPU memory is freed when it returns."""
    t0 = time.time()
    proc = subprocess.run([str(SAM_PYTHON), "-I", str(HERE / "segment.py"), *map(str, args)],
                          capture_output=True, text=True, errors="replace")
    if proc.returncode:
        raise SystemExit(f"segment.py failed:\n{proc.stdout[-2000:]}\n{proc.stderr[-3000:]}")
    return round(time.time() - t0, 1)


def edit_prompt(pick):
    """The text every view's image-model call shares, built from the VLM's answer."""
    text = pick["instruction"].strip()
    if not text.endswith("."):
        text += "."
    if pick["kind"] == "remove":
        text += f" Show what is behind it: {pick['behind'].strip().rstrip('.')}."
    else:
        text += " Keep its shape, position and shading."
    return text + " Keep everything else in the image exactly the same."


def tinted(img, mask, colour=(255, 40, 40), strength=0.5):
    a = np.asarray(img.convert("RGB"), np.float32).copy()
    a[mask] = a[mask] * (1 - strength) + np.array(colour, np.float32) * strength
    return Image.fromarray(a.astype(np.uint8))


def pick(args):
    out = HERE / "cases" / args.name
    seed = out / "seed"
    seed.mkdir(parents=True, exist_ok=True)
    scan = Scan(args.model)
    mesh = scan.mesh()
    cam = Camera.from_angles(scan.position(args.pano), args.yaw, args.pitch, args.fov, SIZE, SIZE)
    view = scan.view(args.pano, cam)
    view.save(seed / "view.png")
    secs = {}

    secs["sam_segments"] = sam("auto", "--image", seed / "view.png", "--out", seed)

    t0 = time.time()
    with Server(extra=["--image-min-tokens", "1024"]) as vlm:
        answer, info = vlm.ask([seed / "view.png"], PICK_PROMPT.format(text=args.text), schema=PICK_SCHEMA)
    secs["vlm_total"], secs["vlm_answer"] = round(time.time() - t0, 1), info["seconds"]
    print(f'request: "{args.text}"\nVLM: {json.dumps(answer)}')

    # Qwen3-VL gives boxes on a 0-1000 scale whatever the image size
    jobs, in_boxes = [], np.zeros((SIZE, SIZE), bool)
    for i, b in enumerate(answer["boxes"]):
        x0, y0, x1, y1 = (float(np.clip(v, 0, 1000)) / 1000 * SIZE for v in b["bbox_2d"])
        box = [min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)]
        in_boxes[int(box[1]):int(np.ceil(box[3])), int(box[0]):int(np.ceil(box[2]))] = True
        jobs.append({"image": str(seed / "view.png"), "out": str(seed / f"box{i}.png"), "box": box})
    (seed / "box_jobs.json").write_text(json.dumps(jobs), encoding="utf-8")
    secs["sam_boxes"] = sam("prompt", "--jobs", seed / "box_jobs.json")
    core = np.zeros((SIZE, SIZE), bool)
    for job in jobs:
        core |= np.asarray(Image.open(job["out"]).convert("L")) > 0

    # lift: where do the rays through the boxes first hit the mesh?
    t0 = time.time()
    pts = hit_points(mesh, cam, grow(in_boxes, 8) | core, STEP)
    valid = np.isfinite(pts[..., 0])
    core_pts = main_parts(pts[coarse(core, STEP, erode=3) & valid])
    if len(core_pts) < 20:
        raise SystemExit("the picked outline has almost no mesh behind it; cannot lift it to 3D")
    added = []
    final = core.copy()
    if answer["kind"] == "remove":
        core_item = VoxelItem.from_points(core_pts)
        z = np.load(seed / "segments.npz")
        masks = np.unpackbits(z["masks"], axis=2)[:, :, :SIZE].astype(bool)
        for i, m in enumerate(masks):
            area = m.sum()
            if (m & core).sum() >= 0.8 * area or (m & in_boxes).sum() < 0.7 * area:
                continue                                    # already picked, or not inside a box
            p = pts[coarse(m, STEP, erode=2) & valid]
            if len(p) < 5:
                continue
            touching = float(core_item.inside(p, margin=ATTACH).mean())
            if touching >= 0.5 and np.median(p[:, 2]) > core_item.lo[2] + 0.05:      # and not a patch of floor
                added.append({"segment": i + 1, "touching": round(touching, 2)})
                final |= m
    item_pts = main_parts(pts[coarse(final, STEP, erode=3) & valid])
    item = VoxelItem.from_points(item_pts)
    item.save(out / "item.npz")
    secs["lift"] = round(time.time() - t0, 1)

    Image.fromarray(final.astype(np.uint8) * 255).save(seed / "mask.png")
    shown = tinted(tinted(view, final & ~core, (60, 120, 255)), core)
    d = ImageDraw.Draw(shown)
    for job in jobs:
        d.rectangle(job["box"], outline=(255, 255, 0), width=3)
    shown.save(seed / "pick.jpg", quality=92)
    size = (item.hi - item.lo).round(2).tolist()
    report = {"request": args.text, "model": args.model, "pano": args.pano,
              "view": {"yaw": args.yaw, "pitch": args.pitch, "fov": args.fov},
              "camera": {"pos": cam.pos.round(4).tolist(), "forward": cam.f.round(5).tolist()},
              "vlm": answer, "boxes_px": [j["box"] for j in jobs], "added_segments": added,
              "mask_fraction": round(float(final.mean()), 4), "voxels": int(len(item.keys)),
              "size_m": size, "prompt": edit_prompt(answer), "seconds": secs}
    (seed / "pick.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"picked {final.mean():.1%} of the view; added segments {[a['segment'] for a in added]}; "
          f"{len(item.keys)} voxels, {size[0]} x {size[1]} x {size[2]} m; seconds {secs}")
    print(seed / "pick.jpg")


def seen_share(scan, mesh, item, n=500):
    """For every panorama, the share of the item's voxels it has a clear line of sight to."""
    c = item.centres
    c = c[np.random.default_rng(0).choice(len(c), min(n, len(c)), replace=False)]
    out = []
    for j in range(len(scan)):
        v = c - scan.position(j)
        dist = np.linalg.norm(v, axis=1)
        t = mesh.cast(scan.position(j), v / dist[:, None])
        out.append(float((t >= dist - 0.12).mean()))
    return out


def views(args):
    out = HERE / "cases" / args.name
    seed = json.loads((out / "seed" / "pick.json").read_text(encoding="utf-8"))
    scan = Scan(seed["model"])
    mesh = scan.mesh()
    item = VoxelItem.load(out / "item.npz")
    item_tris = item.inside(mesh.centroid, margin=item.voxel)
    seed_cam = Camera(seed["camera"]["pos"], seed["camera"]["forward"], seed["view"]["fov"], SIZE, SIZE)
    seed_mask = np.asarray(Image.open(out / "seed" / "mask.png").convert("L")) > 0

    share = seen_share(scan, mesh, item)
    others = sorted((j for j in range(len(scan)) if j != seed["pano"] and share[j] >= args.min_seen),
                    key=lambda j: -share[j])
    targets = [seed["pano"]] + others[:args.max_views - 1]
    print("share of the item each panorama sees:", {j: round(s, 2) for j, s in enumerate(share)}, "-> views", targets)

    # per view: frame a crop on the voxels, find the item's pixels through the mesh, write a SAM job
    work, jobs = [], []
    for ti in targets:
        tdir = out / f"p{ti}"
        tdir.mkdir(parents=True, exist_ok=True)
        cam, dist = frame(item, scan.position(ti), fill=args.fill)
        scan.view(ti, cam).save(tdir / "target.png")
        region = np.asarray(item.mask(cam, dilate=40)) > 0
        pts = hit_points(mesh, cam, region, STEP)
        valid = np.isfinite(pts[..., 0])
        on = np.zeros(valid.shape, bool)
        on[valid] = item.inside(pts[valid], margin=item.voxel)
        off = np.zeros(valid.shape, bool)
        off[valid] = ~item.inside(pts[valid], margin=0.30)          # clearly something else
        on = shrink(grow(on, 1), 1)                                  # close one-cell gaps
        mesh_mask = np.asarray(Image.fromarray(on.astype(np.uint8) * 255).resize((SIZE, SIZE), Image.NEAREST)) > 0
        if not mesh_mask.any():
            print(f"  pano {ti}: the item's voxels are not visible in the crop, skipped")
            continue
        ys, xs = np.nonzero(mesh_mask)
        pad = 0.02 * SIZE
        box = [max(0, xs.min() - pad), max(0, ys.min() - pad), min(SIZE, xs.max() + pad), min(SIZE, ys.max() + pad)]
        cell = lambda m: (np.argwhere(m)[:, ::-1] + 0.5) * STEP      # grid cells -> pixel (x, y)
        pos_cells = shrink(on, 2) if shrink(on, 2).any() else on
        inside_box = np.zeros_like(on)
        inside_box[int(box[1] // STEP):int(box[3] // STEP) + 1, int(box[0] // STEP):int(box[2] // STEP) + 1] = True
        positive = spread(cell(pos_cells), 8)
        negative = spread(cell(shrink(off, 3) & inside_box), 6)
        points = np.concatenate([positive, negative]) if len(negative) else positive
        jobs.append({"image": str(tdir / "target.png"), "out": str(tdir / "sam.png"), "box": box,
                     "points": points.round(1).tolist(), "labels": [1] * len(positive) + [0] * len(negative)})
        Image.fromarray(mesh_mask.astype(np.uint8) * 255).save(tdir / "mesh_mask.png")
        work.append((ti, cam, dist, mesh_mask))

    (out / "sam_jobs.json").write_text(json.dumps(jobs), encoding="utf-8")
    secs = sam("prompt", "--jobs", out / "sam_jobs.json")
    jobs = json.loads((out / "sam_jobs.json").read_text(encoding="utf-8"))
    print(f"SAM outlined {len(jobs)} views in {secs} s (including loading the model)")

    report = {"case": args.name, "model": seed["model"], "what": seed["vlm"]["item"],
              "label": f"{seed['vlm']['item']} {'removed' if seed['vlm']['kind'] == 'remove' else 'changed'}",
              "request": seed["request"], "prompt": seed["prompt"], "pick": seed["vlm"],
              "item": {"voxels": "item.npz", "voxel_m": item.voxel, "count": int(len(item.keys))},
              "seen_share": [round(s, 3) for s in share], "targets": []}
    rows = []
    for (ti, cam, dist, mesh_mask), job in zip(work, jobs):
        tdir = out / f"p{ti}"
        sam_mask = np.asarray(Image.open(job["out"]).convert("L")) > 0
        # the mesh says roughly where, SAM says exactly where the edge is: SAM's outline counts only
        # near the mesh's answer, and the middle of the mesh's answer counts even if SAM left it out
        mask = (sam_mask & grow(mesh_mask, 24)) | shrink(mesh_mask, 8)
        if ti == seed["pano"]:
            mask |= reproject(seed_mask, seed_cam, cam)              # same position: the user's pick, exactly
        mask = grow(mask, 6)
        agree = (sam_mask & mesh_mask).sum() / max((sam_mask | mesh_mask).sum(), 1)
        entry, tiles = build_target(scan, mesh, item, item_tris, ti, cam, dist,
                                    Image.fromarray(mask.astype(np.uint8) * 255), tdir,
                                    max_refs=3, ref_fill=min(0.5, args.fill))
        entry.update({"seen_share": round(share[ti], 3), "sam_score": job["score"],
                      "mesh_sam_overlap": round(float(agree), 3)})
        report["targets"].append(entry)
        both = tinted(tinted(Image.open(tdir / "target.png"), mesh_mask, (60, 120, 255), 0.45), sam_mask & ~mesh_mask, (255, 220, 0), 0.5)
        d = ImageDraw.Draw(both)
        d.rectangle(job["box"], outline=(255, 255, 0), width=2)
        for (x, y), lab in zip(job["points"], job["labels"]):
            d.ellipse([x - 6, y - 6, x + 6, y + 6], fill=(0, 255, 0) if lab else (255, 0, 0), outline=(0, 0, 0))
        both.save(tdir / "mask_steps.jpg", quality=90)
        rows.append([(both, f"pano {ti}: blue = mesh, yellow = SAM adds; dots = prompts (overlap {agree:.0%})")] + tiles[1:])
    review_sheet(rows, out / "review.jpg")
    (out / "case.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(out / "review.jpg")


def run_all(args):
    pick(args)
    views(args)
    meta = json.loads((HERE / "cases" / args.name / "case.json").read_text(encoding="utf-8"))
    order = [str(t["pano"]) for t in meta["targets"]]
    py = sys.executable
    steps = [[py, str(HERE / "run_qwen.py"), "--case", args.name, "run", "--quant", "q4", "--variant", "chain", "--views", *order],
             [py, str(HERE / "run_qwen.py"), "--case", args.name, "grow", "--quant", "q4", "--variant", "chain",
              "--views", *order, "--pcts", "100", "--match"]]
    steps += [[py, "-I", str(HERE / "paste_pano.py"), "--case", args.name, "--quant", "q4", "--variants", "chain",
               "--view", v, "--pcts", "100", "--export"] for v in order]
    for cmd in steps:
        print(">", " ".join(cmd[1:]))
        subprocess.run(cmd, check=True)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("pick", "all"):
        p = sub.add_parser(name)
        p.add_argument("--name", required=True, help="case name: files go to cases/<name>/")
        p.add_argument("--model", default="zzvymDx5ty7")
        p.add_argument("--pano", type=int, required=True, help="0-based panorama the user is standing on")
        p.add_argument("--yaw", type=float, required=True)
        p.add_argument("--pitch", type=float, default=0)
        p.add_argument("--fov", type=float, default=75)
        p.add_argument("--text", required=True, help='the request, e.g. "remove the couch"')
    for name in ("views", "all"):
        v = sub.choices[name] if name == "all" else sub.add_parser(name)
        if name == "views":
            v.add_argument("--name", required=True)
        v.add_argument("--max-views", type=int, default=4)
        v.add_argument("--min-seen", type=float, default=0.2, help="a panorama must see this share of the item's voxels")
        v.add_argument("--fill", type=float, default=0.45, help="share of the crop the item spans (0.45 leaves room for a +100%% paste mask)")
    args = ap.parse_args()
    {"pick": pick, "views": views, "all": run_all}[args.cmd](args)


if __name__ == "__main__":
    main()

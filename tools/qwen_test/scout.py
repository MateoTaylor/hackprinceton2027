"""Look around a downloaded scan to choose a test item.

  python scout.py at X Y Z [--fov 60] [--size 640]     every panorama aimed at one world point
  python scout.py view PANO YAW PITCH [--fov 60] [--size 1024] [--grid]
  python scout.py hit PANO YAW PITCH                   mesh crossings along a view direction

PANO is the 0-based index into the manifest's locations. Images go to cases/_scout/ (git-ignored).
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))   # so `python -I` still finds pano.py

import numpy as np
from PIL import Image, ImageDraw

from pano import Camera, Scan, draw_grid

OUT = Path(__file__).resolve().parent / "cases" / "_scout"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="zzvymDx5ty7")
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("at")
    a.add_argument("xyz", nargs=3, type=float)
    a.add_argument("--fov", type=float, default=60)
    a.add_argument("--size", type=int, default=640)
    v = sub.add_parser("view")
    v.add_argument("pano", type=int)
    v.add_argument("yaw", type=float)
    v.add_argument("pitch", type=float)
    v.add_argument("--fov", type=float, default=60)
    v.add_argument("--size", type=int, default=1024)
    v.add_argument("--grid", action="store_true")
    h = sub.add_parser("hit")
    h.add_argument("pano", type=int)
    h.add_argument("yaw", type=float)
    h.add_argument("pitch", type=float)
    t = sub.add_parser("tour")
    t.add_argument("panos", nargs="+", type=int)
    t.add_argument("--pitch", type=float, default=-15)
    t.add_argument("--fov", type=float, default=75)
    t.add_argument("--size", type=int, default=320)
    args = ap.parse_args()

    scan = Scan(args.model)
    OUT.mkdir(parents=True, exist_ok=True)

    if args.cmd == "tour":                      # one row per panorama, six headings 60 degrees apart
        yaws = range(0, 360, 60)
        sheet = Image.new("RGB", (len(yaws) * args.size, len(args.panos) * args.size))
        for r, i in enumerate(args.panos):
            for c, yaw in enumerate(yaws):
                cam = Camera.from_angles(scan.position(i), yaw, args.pitch, args.fov, args.size, args.size)
                img = scan.view(i, cam)
                d = ImageDraw.Draw(img)
                d.rectangle([0, 0, 96, 16], fill=(0, 0, 0))
                d.text((3, 2), f"pano {i} yaw {yaw}", fill=(255, 255, 0))
                sheet.paste(img, (c * args.size, r * args.size))
        path = OUT / ("tour_" + "_".join(map(str, args.panos)) + ".jpg")
        sheet.save(path, quality=88)
        print(path)
        return

    if args.cmd == "at":
        target = np.array(args.xyz)
        tiles = []
        for i in range(len(scan)):
            cam = Camera.looking_at(scan.position(i), target, args.fov, args.size, args.size)
            img = scan.view(i, cam)
            d = ImageDraw.Draw(img)
            c = args.size // 2
            d.line([(c - 12, c), (c + 12, c)], fill=(255, 0, 255), width=2)
            d.line([(c, c - 12), (c, c + 12)], fill=(255, 0, 255), width=2)
            dist = np.linalg.norm(target - scan.position(i))
            d.rectangle([0, 0, 190, 18], fill=(0, 0, 0))
            d.text((4, 3), f"pano {i}  dist {dist:.2f} m", fill=(255, 255, 0))
            tiles.append(img)
        cols = 3
        rows = (len(tiles) + cols - 1) // cols
        sheet = Image.new("RGB", (cols * args.size, rows * args.size))
        for n, t in enumerate(tiles):
            sheet.paste(t, ((n % cols) * args.size, (n // cols) * args.size))
        path = OUT / "at_{:.2f}_{:.2f}_{:.2f}.jpg".format(*target)
        sheet.save(path, quality=88)
        print(path)

    elif args.cmd == "view":
        cam = Camera.from_angles(scan.position(args.pano), args.yaw, args.pitch, args.fov, args.size, args.size)
        img = scan.view(args.pano, cam)
        if args.grid:
            img = draw_grid(img)
        path = OUT / f"view_p{args.pano}_y{args.yaw:g}_t{args.pitch:g}_f{args.fov:g}.jpg"
        img.save(path, quality=90)
        print(path)

    else:
        mesh = scan.mesh()
        cam = Camera.from_angles(scan.position(args.pano), args.yaw, args.pitch, 60, 8, 8)
        for t, tri in mesh.all_hits(cam.pos, cam.f)[:8]:
            p = cam.pos + t * cam.f
            n = mesh.normal[tri]
            print(f"t={t:6.3f} m  point=({p[0]:.3f}, {p[1]:.3f}, {p[2]:.3f})  normal=({n[0]:.2f}, {n[1]:.2f}, {n[2]:.2f})")


if __name__ == "__main__":
    main()

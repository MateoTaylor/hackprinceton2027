"""Run the retexture cases in cases/retexture.json and put the results side by side.

  python -m edit_agent.change.suite [--only a,b] [--group g] [--pans-only] [--single] [--max-views N]
                                    [--variants auto | alone,chain,guide] [--refind] [--label L] [--list]

For each case: the finder (cached in data/edit_agent/change/suite/found/), then `pans` for a case marked
"pans" (the thing edited in up to N panoramas that see it), else `one`. Each pans case gets a
consistency sheet: the thing cropped from every panorama, so its new texture can be compared across
points of view. A suite run writes summary.json, summary.md and overview pages to
data/edit_agent/change/suite/<time>-<label>/. A case's `verdict` (written by a person after looking at
its sheet) is compared with what the checks said, so the suite also measures the checks.
"""
import argparse
import json
import os
import re
import shlex
import subprocess
import sys
import time
import traceback
from argparse import Namespace
from datetime import datetime
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from edit_agent.change.__main__ import one, pans
from edit_agent.config import ROOT

HERE = Path(__file__).resolve().parents[2]                     # tools/edit_agent
CASES = HERE / "cases" / "retexture.json"
SUITE = ROOT / "data" / "edit_agent" / "change" / "suite"
FOUND = SUITE / "found"
SCORES = ("change_inside", "drift_outside", "shading", "detail", "hue_off", "old_left", "colour_share",
          "effect_share", "form_iou")


def load(only=None, group=None):
    cases = json.loads(CASES.read_text(encoding="utf-8"))["cases"]
    if only:                                                   # in the order given
        by = {c["name"]: c for c in cases}
        missing = [n for n in only if n not in by]
        if missing:
            raise SystemExit(f"no such case: {missing}")
        cases = [by[n] for n in only]
    if group:
        cases = [c for c in cases if c.get("group") == group]
    return cases


def find(case, refind=False):
    """The case's found.json: cached by its finder command, else run the finder."""
    FOUND.mkdir(parents=True, exist_ok=True)
    cache = FOUND / f"{case['name']}.json"
    if cache.exists() and not refind:
        c = json.loads(cache.read_text(encoding="utf-8"))
        if c["find"] == case["find"] and Path(c["found"]).exists():
            return c
    t0 = time.time()
    cmd = [sys.executable, "-m", "edit_agent.find", *shlex.split(case["find"]), "--name", f"suite-{case['name']}"]
    p = subprocess.run(cmd, cwd=HERE, capture_output=True, text=True, encoding="utf-8", errors="replace",
                       env={**os.environ, "PYTHONPATH": "."})
    out = p.stdout + p.stderr
    status = re.search(r"^(FOUND|ASKED|NOT_FOUND) \((.*)$", out, re.M)
    path = re.search(r"^found: (.+)$", out, re.M)
    c = {"find": case["find"], "status": status.group(1).lower() if status else "error",
         "reason": status.group(2).rstrip(")") if status else out[-600:],
         "found": path.group(1).strip() if path else None, "seconds": round(time.time() - t0, 1)}
    if c["found"]:
        f = json.loads(Path(c["found"]).read_text(encoding="utf-8"))
        c["item"] = f["target"].get("item")
        c["sheet"] = str(Path(c["found"]).parent / "sheet.jpg")
    cache.write_text(json.dumps(c, indent=1), encoding="utf-8")
    return c



def run_case(case, args):
    row = {"name": case["name"], "group": case.get("group"), "request": case["request"],
           "verdict": case.get("verdict"), "expect": case.get("expect")}
    t0 = time.time()
    try:
        f = find(case, args.refind)
        row["finder"] = {k: f.get(k) for k in ("status", "reason", "item", "seconds", "sheet")}
        if not f.get("found"):
            row["status"] = "finder_failed"
            return row
        ns = Namespace(input=f["found"], preset=None, name=f"suite-{case['name']}", change=None)
        if not args.single and case.get("pans"):
            ns = Namespace(**vars(ns), variants=args.variants, max_views=args.max_views, min_seen=0.3,
                           no_vlm=False)
            run, record, table = pans(ns)
            row["pans"] = [{"pano": t["pano"], "variant": t["variant"], "issues": t["issues"],
                            **{k: (t.get("agree") or {}).get(k) for k in ("same_parts", "change_gap", "colour_gap_photo",
                                                                          "pattern", "pattern_photo")}} for t in table]
            row["agree"] = agree_means(row["pans"])
            row["consistency"] = consistency(run) if table else None
        else:
            run, record = one(ns)
        row["status"] = "ran"
        row["run"] = str(run)
        row["change"] = record["target"].get("change")
        row["issues"] = [[i["kind"], i["severity"], i.get("source"), i["evidence"]] for i in record["issues"]]
        row["scores"] = {k: record["scores"].get(k) for k in SCORES if record["scores"].get(k) is not None}
        fnd = record.get("findings") or {}
        row["vlm"] = [{k: e.get(k) for k in ("looks", "is_new", "old_seen", "natural")} for e in fnd.get("each", [])]
        row["photo"], row["raw"], row["edited"] = record["view"], record["raw"], record["edited"]
    except Exception as e:                                         # one broken case must not stop the suite
        row["status"] = "error"
        row["error"] = f"{type(e).__name__}: {e}"
        row["trace"] = traceback.format_exc()[-1500:]
    row["seconds"] = round(time.time() - t0, 1)
    return row


def judged(row):
    """What the checks said against the case's verdict and expectation."""
    if row.get("status") != "ran":
        return None
    flagged = any(sev >= 2 for _, sev, *_ in row["issues"])
    out = {"flagged": flagged}
    v = (row.get("verdict") or "").lower()
    if v:
        good = v.startswith("good")
        out["agrees"] = good != flagged
        out["kind"] = ("true pass" if good and not flagged else "false alarm" if good else
                       "caught" if flagged else "missed")
    exp = row.get("expect")
    if exp:
        kinds = {k for k, *_ in row["issues"]}
        out["expect_met"] = (not flagged) if exp == "clean" else bool(kinds & set(exp))
    return out


def overview(rows, out, per=8, side=300):
    font = ImageFont.truetype("arial.ttf", 15)
    pages = []
    ran = [r for r in rows if r.get("status") == "ran"]
    for k in range(0, len(ran), per):
        chunk = ran[k:k + per]
        page = Image.new("RGB", (side * 3, (side + 44) * len(chunk)), (25, 25, 25))
        d = ImageDraw.Draw(page)
        for i, r in enumerate(chunk):
            y = i * (side + 44)
            for j, key in enumerate(("photo", "raw", "edited")):
                im = Image.open(r[key]).convert("RGB")
                im.thumbnail((side, side))
                page.paste(im, (j * side, y + 44))
            issues = ", ".join(f"{kind}({sev})" for kind, sev, *_ in r["issues"]) or "no issues"
            d.text((4, y + 4), f"{r['name']}  [{r.get('group')}]  {r['request']}", fill=(255, 255, 0), font=font)
            looks = "; ".join(v["looks"] for v in r.get("vlm", []) if v.get("looks"))
            d.text((4, y + 23), f"{issues}  |  VLM: {looks}"[:130], fill=(200, 230, 255), font=font)
        path = out / f"overview_{k // per}.jpg"
        page.save(path, quality=85)
        pages.append(str(path))
    return pages


def agree_means(views):
    """Per variant, the mean agreement with the first view over the other panoramas."""
    out = {}
    for v in dict.fromkeys(x["variant"] for x in views):
        e = [x for x in views if x["variant"] == v]
        mean = lambda k: (round(float(np.mean(vals)), 3) if (vals := [x[k] for x in e if x.get(k) is not None]) else None)
        out[v] = {"views": len(e), "change_gap": mean("change_gap"), "pattern": mean("pattern"),
                  "pattern_photo": mean("pattern_photo"), "same_parts": mean("same_parts"),
                  "flagged": sum(1 for x in e if any(sev >= 2 for _, sev in x["issues"]))}
    return out


def _square(mask, size, margin=0.1):
    """A square box around the mask, `margin` of its size on each side, inside the picture."""
    ys, xs = np.nonzero(mask)
    if not len(xs):
        return [0, 0, size[0], size[1]]
    x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
    half = max(x1 - x0, y1 - y0) * (1 + 2 * margin) / 2
    half = min(half, min(size) / 2)
    cx = min(max((x0 + x1) / 2, half), size[0] - half)
    cy = min(max((y0 + y1) / 2, half), size[1] - half)
    return [int(cx - half), int(cy - half), int(cx + half), int(cy + half)]


def consistency(run, side=300):
    """One object from every panorama: a row per view, cropped to the thing, so its new texture can be
    compared across points of view. Columns: the photo, the first view's result moved into this view
    through the mesh (what this view should look like), then each variant's result. Returns the path."""
    run = Path(run)
    pj = json.loads((run / "pans.json").read_text(encoding="utf-8"))
    rep = json.loads((run / "report.json").read_text(encoding="utf-8"))
    variants = list(dict.fromkeys(v["variant"] for v in pj["views"]))
    panos = list(dict.fromkeys(v["pano"] for v in pj["views"]))
    cols = ["photo", "expected", *variants]
    head, cap = 50, 40
    font = ImageFont.truetype("arial.ttf", 15)
    small = ImageFont.truetype("arial.ttf", 13)
    page = Image.new("RGB", (side * len(cols), head + (side + cap) * (1 + len(panos))), (25, 25, 25))
    d = ImageDraw.Draw(page)
    d.text((6, 6), f"{rep['request']}", fill=(255, 255, 0), font=font)
    means = []
    for v in variants:
        e = [x["agree"] for x in pj["views"] if x["variant"] == v and x.get("agree")]
        if e:
            gap = np.nanmean([x.get("change_gap") or np.nan for x in e])
            pat = np.nanmean([x.get("pattern") or np.nan for x in e])
            means.append(f"{v}: gap {gap:.1f}, pattern {pat:.2f}")
    ceiling = [x["agree"].get("pattern_photo") for x in pj["views"] if x.get("agree") and x["agree"].get("pattern_photo") is not None]
    d.text((6, 27), "  |  ".join(means) + (f"  |  photos' own pattern {np.mean(ceiling):.2f}" if ceiling else ""),
           fill=(200, 230, 255), font=small)

    def cell(path, box, col, row, text, colour=(220, 220, 220)):
        y = head + row * (side + cap)
        if path and Path(path).exists():
            im = Image.open(path).convert("RGB")
            if box is None:
                box = [0, 0, *im.size]
            page.paste(im.crop(box).resize((side, side), Image.LANCZOS), (col * side, y))
        d.text((col * side + 4, y + side + 3), text[:44], fill=colour, font=small)

    first_mask = np.asarray(Image.open(rep["mask"]).convert("L")) > 127
    box = _square(first_mask, first_mask.shape[::-1])
    fp = pj["first"]["pano"]
    cell(rep["view"], box, 0, 0, f"pano {fp} photo (found view)")
    cell(rep["edited"], box, 1, 0, f"pano {fp} result (all variants copy it)")
    for r, j in enumerate(panos, 1):
        vdir = run / f"p{j}"
        mask = np.asarray(Image.open(vdir / "mask.png").convert("L")) > 127
        box = _square(mask, mask.shape[::-1])
        entries = {x["variant"]: x for x in pj["views"] if x["pano"] == j}
        any_e = next(iter(entries.values()))
        cell(vdir / "view.png", box, 0, r, f"pano {j} photo, {any_e.get('distance_m', '?')} m")
        cell(vdir / "guide.png", box, 1, r, f"pano {fp} result moved here" if (vdir / "guide.png").exists() else "")
        for c, v in enumerate(variants, 2):
            e = entries.get(v)
            if not e:
                continue
            a = e.get("agree") or {}
            bad = [k for k, sev in e.get("issues", []) if sev >= 2]
            text = f"{v}: gap {a.get('change_gap')}, pat {a.get('pattern')}/{a.get('pattern_photo')}"
            cell(vdir / v / "edited.png", box, c, r, text + (f" {','.join(bad)}" if bad else ""),
                 (255, 160, 160) if bad else (220, 220, 220))
    path = run / "consistency.jpg"
    page.save(path, quality=88)
    return str(path)


def table(rows):
    lines = ["| case | group | finder | change | issues | change_inside | shading | hue_off | old_left | checks vs verdict |",
             "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"]
    for r in rows:
        s = r.get("scores", {})
        ch = r.get("change") or {}
        j = r.get("judged") or {}
        issues = ", ".join(f"{k}({sev})" for k, sev, *_ in r.get("issues", [])) or ("-" if r.get("status") == "ran"
                                                                                   else r.get("status"))
        lines.append(f"| {r['name']} | {r.get('group')} | {(r.get('finder') or {}).get('status')} | "
                     f"{ch.get('style', '')} {ch.get('from', '')}->{ch.get('to', '')} | {issues} | "
                     f"{s.get('change_inside', '')} | {s.get('shading', '')} | {s.get('hue_off', '')} | "
                     f"{s.get('old_left', '')} | {j.get('kind', '')} |")
    multi = [r for r in rows if r.get("agree")]
    if multi:
        lines += ["", "Across panoramas, against the first view (mean over the other views): change_gap (lower is",
                  "closer colour), pattern / the photos' own pattern (higher is closer detail), flagged views.", "",
                  "| case | variant | views | change_gap | pattern / photos | same_parts | flagged |",
                  "| --- | --- | --- | --- | --- | --- | --- |"]
        for r in multi:
            for v, a in r["agree"].items():
                lines.append(f"| {r['name']} | {v} | {a['views']} | {a['change_gap']} | {a['pattern']} / "
                             f"{a['pattern_photo']} | {a['same_parts']} | {a['flagged']} |")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser(prog="python -m edit_agent.change.suite")
    ap.add_argument("--only", type=lambda v: v.split(","))
    ap.add_argument("--group")
    ap.add_argument("--single", action="store_true", help="one view only, also for the cases marked pans")
    ap.add_argument("--pans-only", action="store_true", help="only the cases marked pans")
    ap.add_argument("--variants", type=lambda v: v.split(","), default=["auto"],
                    help="auto (guide, or alone where the guide is mostly empty), or alone,chain,guide to compare")
    ap.add_argument("--max-views", type=int, default=4, help="views per thing, the found one included")
    ap.add_argument("--refind", action="store_true", help="run the finder again even when cached")
    ap.add_argument("--label", default="suite")
    ap.add_argument("--list", action="store_true")
    args = ap.parse_args()
    cases = load(args.only, args.group)
    if args.pans_only:
        cases = [c for c in cases if c.get("pans")]
    if args.list:
        for c in cases:
            print(f"{c['name']:22} {c.get('group', ''):10} {'pans ' if c.get('pans') else '     '}{c['request']}")
        return
    out = SUITE / f"{datetime.now():%Y%m%d-%H%M%S}-{args.label}"
    out.mkdir(parents=True)
    rows = []
    for n, case in enumerate(cases, 1):
        print(f"\n=== [{n}/{len(cases)}] {case['name']}: {case['request']}", flush=True)
        row = run_case(case, args)
        row["judged"] = judged(row)
        rows.append(row)
        (out / "summary.json").write_text(json.dumps(rows, indent=1, default=str), encoding="utf-8")
        print(f"=== {case['name']}: {row.get('status')} {[i[0] for i in row.get('issues', [])]} "
              f"{row.get('error', '')} ({row['seconds']} s)", flush=True)
    pages = overview(rows, out)
    (out / "summary.md").write_text(table(rows) + "\n", encoding="utf-8")
    print("\n" + table(rows))
    print("\noverview:", *pages, sep="\n  ")
    sheets = [r["consistency"] for r in rows if r.get("consistency")]
    if sheets:
        print("across panoramas:", *sheets, sep="\n  ")
    print("summary:", out / "summary.json")


if __name__ == "__main__":
    main()

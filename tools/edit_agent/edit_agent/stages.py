"""One picture of the stages of a run, left to right: the view, what the VLM found, the mask, the
image model's redraw, the pasted first pass, what the check flagged, and the second pass.

Several runs become rows of one picture, so that views of the same thing from different panoramas
can be compared. It reads the run folders only; no model runs.

  python -m edit_agent.stages RUN_FOLDER [RUN_FOLDER ...] [--out FILE.png] [--title TEXT]
  python -m edit_agent.stages --suite TABLE.json [--out FOLDER]      one picture per case of a suite table

Pictures go to data/edit_agent/outputs/stages/ (git-ignored) unless --out says otherwise.
"""
import argparse
import json
import re
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from edit_agent import metrics, report
from edit_agent.config import ROOT, Limits

OUT = ROOT / "data" / "edit_agent" / "outputs" / "stages"
TILE, GAP, LINE = 420, 10, 21
BG, TEXT, DIM = (24, 24, 24), (235, 235, 235), (150, 150, 150)
YELLOW, RED, GREEN, ORANGE = (255, 200, 0), (235, 60, 60), (110, 220, 130), (255, 140, 0)
TITLES = ("1  The view", "2  VLM: what to edit", "3  SAM: the mask", "4  Image model: its redraw",
          "5  First pass: pasted", "6  Check: what was flagged", "7  Second pass")


def _font(size):
    return ImageFont.load_default(size)


def _wrap(text, font, width):
    lines = []
    for part in str(text).split("\n"):
        line = ""
        for word in part.split():
            trial = f"{line} {word}".strip()
            if line and font.getlength(trial) > width:
                lines.append(line)
                line = word
            else:
                line = trial
        lines.append(line)
    return lines


def _mark(img, boxes, colour, labels=None):
    draw, font = ImageDraw.Draw(img), _font(22)
    for n, box in enumerate(boxes):
        if not box:
            continue
        draw.rectangle(box, outline=colour, width=4)
        if labels:
            x, y = box[0], max(0, box[1] - 28)
            draw.rectangle([x, y, x + font.getlength(labels[n]) + 12, y + 28], fill=colour)
            draw.text((x + 6, y + 2), labels[n], fill=(255, 255, 255), font=font)
    return img


def _blank(size, words):
    img = Image.new("RGB", size, (44, 44, 44))
    draw, font = ImageDraw.Draw(img), _font(30)
    lines = _wrap(words, font, size[0] - 80)
    for n, line in enumerate(lines):
        draw.text(((size[0] - font.getlength(line)) / 2, size[1] / 2 - 20 * len(lines) + 40 * n), line, fill=DIM,
                  font=font)
    return img


def _checked(rec, limits):
    """The words under the check panel: the verdict, each issue and note, and what the VLM said."""
    result, found = rec["report"], rec.get("findings") or {}
    passed = result["verdict"] == "pass"
    lines = [("PASS: no glaring problems found" if passed else f"FIX: {len(result['issues'])} issue(s) for a second pass",
              GREEN if passed else RED)]
    lines += [(f"{n}. {i['kind']} [{i['source']}]: {i['evidence']}", RED) for n, i in enumerate(result["issues"], 1)]
    lines += [(f"note, {i['kind']}: {i['evidence']}", DIM) for i in result["notes"]]
    if found.get("changed"):
        lines.append((f"VLM, before against after: \"{found['changed']}\"", TEXT))
    if "visible" in found:
        close = "still visible: " + (", ".join(found["visible"]) or "nothing")
        close += "".join(f"; {key} {found[key]}" for key in ("patch", "shadow", "glow") if key in found)
        lines.append((f"VLM, close-up of the result: {close}", TEXT))
    for letter, place in zip("abc", found.get("places") or []):
        what = "edges gone" if place["kind"] == "edges_lost" else "new edges"
        lines.append((f"{letter} ({what}): \"{place['before']['inside']}\" [{place['before']['kind']}] -> "
                      f"\"{place['after']['inside']}\" [{place['after']['kind']}]", ORANGE))
    step = result["scores"].get("border_step")
    if step is not None:
        lines.append((f"numbers: tone step at the paste border {step} (limit {limits.border_step:g})", DIM))
    return lines


def panels(run, limits=Limits()):
    """The seven panels of one run: a picture and its lines of words (text, colour) each."""
    run = Path(run)
    final = json.loads((run / "report.json").read_text(encoding="utf-8"))
    earlier = run / "report_1.json"                                           # kept when a repair ran
    first = json.loads(earlier.read_text(encoding="utf-8")) if earlier.exists() else final
    view = Image.open(run / "view.png").convert("RGB")
    target, timings = final.get("target") or {}, final.get("timings") or {}
    scan = final.get("scan")
    where = (f"panorama {scan['pano']}, yaw {scan.get('yaw', 0):g}, pitch {scan.get('pitch', 0):g}, "
             f"fov {scan.get('fov', 75):g}") if scan else "a given picture"
    seconds = round(sum(t["seconds"] for t in timings.values()), 1)
    out = [(view, [(where, YELLOW), (f"request: \"{final['request']}\"", TEXT), (f"{seconds} s in all", DIM)])]

    boxes = target.get("boxes") or []
    if boxes:
        words = [(f"found: {target['item']}", TEXT), (f"behind it: {target['behind']}", TEXT),
                 (f"to the image model: {target['instruction']}", TEXT)]
        out.append((_mark(view.copy(), [b["box"] for b in boxes], YELLOW, [b["label"] for b in boxes]), words))
    else:
        out.append((_blank(view.size, "not found"), [("The VLM did not find the thing in this view.", RED)]))

    scores = first["report"]["scores"]
    if final.get("mask"):
        sam = (timings.get("segment") or {}).get("sam_scores") or []
        words = [(f"the item covers {scores.get('mask_share', 0):.1%} of the picture; "
                  f"{scores.get('paste_share', 0):.1%} is pasted", TEXT),
                 ("red: the item. pink: its shadow or glow, where the image model changed the light. "
                  "blue line: the area that is pasted.", DIM)]
        if sam:
            words.append(("SAM's confidence: " + ", ".join(f"{s:.2f}" for s in sam if s is not None), DIM))
        out.append((report.overlay(view, run / "mask.png", run / "effect.png", run / "paste_mask.png"), words))
    else:
        out.append((_blank(view.size, "no mask"), [("Nothing was cut out.", RED)]))

    if (run / "raw.png").exists():
        gen = timings.get("generate") or {}
        took = f" ({gen['steps']} steps, {gen['seconds']} s)" if gen else ""
        out.append((Image.open(run / "raw.png").convert("RGB").resize(view.size, Image.LANCZOS),
                    [(f"Qwen-Image redraws the whole picture from the instruction{took}.", TEXT),
                     ("Only the part inside the blue line of 3 is used.", DIM)]))
    else:
        out.append((_blank(view.size, "not generated"), []))

    if (run / "edited.png").exists():
        pasted = Image.open(run / "edited.png").convert("RGB")
        out.append((pasted, [("The redraw pasted into the original, with its tones matched at the border. "
                              "Everything outside the blue line is the original photo.", TEXT)]))
        places = (first.get("findings") or {}).get("places") or first.get("regions") or []
        marked = _mark(pasted.copy(), [p["box"] for p in places], ORANGE, list("abc"[:len(places)]))
        issues = first["report"]["issues"]
        _mark(marked, [i["region"] for i in issues], RED, [str(n) for n in range(1, len(issues) + 1)])
        out.append((marked, _checked(first, limits)))
    else:
        out += [(_blank(view.size, "not pasted"), []), (_blank(view.size, "not checked"), _checked(first, limits))]

    repairs = final.get("repairs") or []
    if repairs:
        last = repairs[-1]
        again = Image.open(final["edited"]).convert("RGB")
        area = run / f"edited_{last['pass']}_area.png"
        if area.exists():
            a = np.asarray(again).copy()
            inside = np.asarray(Image.open(area).convert("L")) > 127
            a[metrics.grown(inside, 3) & ~inside] = GREEN
            again = Image.fromarray(a)
        words = [(f"{last['action']}: the original's detail was put back in {len(last['boxes'])} place(s), in the "
                  "tone of the edit around it (green line)", TEXT)]
        out.append((again, words + _checked(final, limits)))
    elif first["report"]["verdict"] == "pass":
        out.append((_blank(view.size, "not needed"), [("The check passed, so nothing was repaired.", DIM)]))
    else:
        kinds = ", ".join(dict.fromkeys(i["kind"] for i in first["report"]["issues"]))
        out.append((_blank(view.size, "no repair built yet"),
                    [(f"Reported for a second pass, but no repair exists yet for: {kinds}.", DIM)]))
    return out


def draw(runs, out, title=None, limits=Limits()):
    """Write one PNG: a row of panels per run."""
    rows = [panels(run, limits) for run in runs]
    font, head, big = _font(16), _font(19), _font(25)
    width = len(TITLES) * TILE + (len(TITLES) + 1) * GAP
    wrapped = [[[(part, colour) for text, colour in words for part in _wrap(text, font, TILE - 8)]
                for _, words in row] for row in rows]
    heights = [TILE + 8 + LINE * max(len(lines) for lines in row) + 16 for row in wrapped]
    top = 86 if title else 40
    sheet = Image.new("RGB", (width, top + sum(heights)), BG)
    pen = ImageDraw.Draw(sheet)
    if title:
        pen.text((GAP, 12), title, fill=(255, 255, 255), font=big)
    for col, name in enumerate(TITLES):
        pen.text((GAP + col * (TILE + GAP), top - 28), name, fill=YELLOW, font=head)
    y = top
    for row, texts, height in zip(rows, wrapped, heights):
        for col, ((img, _), lines) in enumerate(zip(row, texts)):
            x = GAP + col * (TILE + GAP)
            k = TILE / max(img.size)
            sheet.paste(img.resize((round(img.size[0] * k), round(img.size[1] * k)), Image.LANCZOS), (x, y))
            for n, (line, colour) in enumerate(lines):
                pen.text((x + 2, y + TILE + 8 + LINE * n), line, fill=colour, font=font)
        y += height
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("runs", nargs="*", help="run folders, one row each")
    ap.add_argument("--suite", help="a suite table (<time>-suite.json): one picture per case")
    ap.add_argument("--out", help="the PNG to write, or with --suite the folder")
    ap.add_argument("--title")
    args = ap.parse_args()
    note = "one row per panorama, each edited on its own"
    if args.suite:
        cases = {}
        for row in json.loads(Path(args.suite).read_text(encoding="utf-8"))["runs"]:
            cases.setdefault(re.sub(r"^suite-|-p\d+$", "", row["name"]), []).append(row["run_dir"])
        for case, runs in cases.items():
            request = json.loads((Path(runs[0]) / "report.json").read_text(encoding="utf-8"))["request"]
            print(draw(runs, Path(args.out or OUT) / f"{case}.png", f"{case}: \"{request}\"   ({note})"))
    elif args.runs:
        out = args.out or OUT / f"{Path(args.runs[0]).name}.png"
        print(draw(args.runs, out, args.title))
    else:
        ap.error("give run folders or --suite")


if __name__ == "__main__":
    main()

"""Turn the measurements and the VLM's findings into the list a second pass would work from,
and draw a plain picture of the run (before, mask, after with the issues marked, and a map of what changed)."""
import textwrap
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from edit_agent import metrics
from edit_agent.schemas import GRADES, REPAIRS, Issue, QAReport, head, parts, place_finding, request_findings


def _issue(kind, severity, source, evidence, region=None, action=None, what=None, missed=False):
    return Issue(kind=kind, severity=severity, source=source, evidence=evidence, region=region, repair=REPAIRS[kind],
                 action=action, what=what, missed=missed)


def weight(report):
    """How bad a report is, to compare a repair with what it started from: the severities added up."""
    return sum(i["severity"] for i in report["issues"])


def build(state, limits):
    target = state.get("target") or {}
    scores = state.get("scores") or {}
    issues, notes = [], []
    if not target.get("boxes"):
        issues.append(_issue("not_found", 3, "vlm", "the thing to edit was not found in the picture"))
    elif not state.get("edited"):
        issues.append(_issue("not_found", 3, "metric", "the segmenter returned an empty mask for the boxes"))
    elif target["kind"] == "change":
        # Mateo-Retexture-Agent's checks (change/checks.py), sorted into issues and notes like a removal's
        from edit_agent.change.checks import flags
        found = state.get("findings") or {}
        for i in flags(scores, found, target):
            issue = Issue(**{k: i[k] for k in ("kind", "severity", "source", "evidence", "region", "repair")})
            (issues if issue.severity >= limits.report_severity else notes).append(issue)
        labels = [b["label"] for b in target["boxes"]]
        for place in found.get("places", []):
            finding = place_finding(place, False, labels)
            if finding:
                kind, severity, evidence, action, what = finding
                issue = _issue(kind, severity, "vlm", evidence, place["box"], action, what)
                (issues if severity >= limits.report_severity else notes).append(issue)
    else:
        for kind, severity, evidence, region in metrics.flags(scores, limits, scores.get("paste_box")):
            issues.append(_issue(kind, severity, "metric", evidence, region))
        found = state.get("findings") or {}
        if target["kind"] == "remove":
            seen = set(found.get("visible", []))                    # names from schemas.parts, one label may hold several
            left = [b["box"] for b in target["boxes"] if seen & set(parts(b["label"]))]
            if left and not any(i.kind == "object_remains" for i in issues):
                region = [min(b[0] for b in left), min(b[1] for b in left), max(b[2] for b in left),
                          max(b[3] for b in left)]
                issues.append(_issue("object_remains", 3, "vlm", "still visible: " + ", ".join(found["visible"]),
                                     region, "remove_again", ", ".join(found["visible"])))
            if found.get("floating"):                               # what stood on the removed thing
                issues.append(_issue("object_remains", 2, "vlm", "left floating, with nothing to hold it up: "
                                     + ", ".join(found["floating"]), found.get("close_box"), "remove_again",
                                     ", ".join(found["floating"])))
            ask = found.get("request")                              # the request's own words, on the whole picture
            if ask:
                boxed = {head(p) for b in target["boxes"] for p in parts(b["label"])}
                for kind, severity, evidence, action, what in request_findings(ask["read"], ask["before"], ask["after"],
                                                                               boxed):
                    issue = _issue(kind, severity, "vlm", evidence, None, action, what, missed=action == "remove_again")
                    (issues if severity >= limits.report_severity else notes).append(issue)
        for (field, grade), (kind, severity, what) in GRADES.items():
            if found.get(field) == grade:
                issue = _issue(kind, severity, "vlm", what, found.get("close_box"))
                (issues if severity >= limits.report_severity else notes).append(issue)
        labels = [b["label"] for b in target["boxes"]]
        for place in found.get("places", []):                       # what the scout marked and the VLM named
            finding = place_finding(place, target["kind"] == "remove", labels)
            if finding:
                kind, severity, evidence, action, what = finding
                issue = _issue(kind, severity, "vlm", evidence, place["box"], action, what)
                (issues if severity >= limits.report_severity else notes).append(issue)
    cleared = state.get("cleared")                                  # leftovers the second removal judged separate
    if cleared:
        for issue in [i for i in issues if i.action == "remove_again" and i.what in cleared["what"]]:
            issues.remove(issue)
            notes.append(issue.model_copy(update={"severity": 1, "action": None,
                                                  "evidence": f"{issue.evidence} (a second look: {cleared['why']})"}))
    # An edit that failed outright (another picture, nothing changed, the colour did not land) has nothing
    # to mend: it is drawn again with a new seed, as Mateo-Retexture-Agent's first view is. A severity-3
    # finding that has a repair of its own (a leftover to remove again) keeps it.
    if target.get("boxes") and state.get("edited"):
        for i, issue in enumerate(issues):
            if issue.severity >= 3 and issue.action is None:
                issues[i] = issue.model_copy(update={"action": "regenerate"})
    issues.sort(key=lambda i: -i.severity)
    if issues:
        summary = f"{len(issues)} issue(s) for a second pass: " + ", ".join(i.kind for i in issues) + "."
        if (state.get("findings") or {}).get("worst"):
            summary += f" The VLM's words: {state['findings']['worst']}"
    else:
        summary = "No glaring problems found."
    numbers = {k: v for k, v in scores.items() if isinstance(v, (int, float))}
    return QAReport(verdict="fix" if issues else "pass", scores=numbers, issues=issues, notes=notes, summary=summary)


def _boxes(img, regions, colour, labels=None, width=3):
    draw = ImageDraw.Draw(img)
    for n, region in enumerate(regions):
        if not region:
            continue
        draw.rectangle(region, outline=colour, width=width)
        if labels:
            draw.rectangle([region[0], region[1], region[0] + 9 * len(labels[n]) + 8, region[1] + 20], fill=colour)
            draw.text((region[0] + 4, region[1] + 3), labels[n], fill=(255, 255, 255), font=ImageFont.load_default(14))
    return img


def overlay(view, mask, effect=None, paste_mask=None):
    """The view with the item in red, its shadow or glow in pink and the pasted area outlined in blue."""
    a = np.asarray(view, np.float32).copy()
    item = np.asarray(Image.open(mask).convert("L")) > 127
    if effect and Path(effect).exists():
        shade = (np.asarray(Image.open(effect).convert("L")) > 127) & ~item
        a[shade] = a[shade] * 0.5 + np.array([255, 40, 200], np.float32) * 0.5
    a[item] = a[item] * 0.5 + np.array([255, 40, 40], np.float32) * 0.5
    if paste_mask and Path(paste_mask).exists():
        area = np.asarray(Image.open(paste_mask).convert("L")) > 127
        a[area & ~metrics.shrunk(area, 3)] = (0, 220, 255)
    return Image.fromarray(a.astype(np.uint8))


def sheet(state, report, out, tile=512):
    view = Image.open(state["view"]).convert("RGB")
    target = state.get("target") or {}
    before = _boxes(view.copy(), [b["box"] for b in target.get("boxes", [])], (255, 200, 0))
    middle, after = view.copy(), view.copy()
    changed = Image.new("RGB", view.size)
    if state.get("mask"):
        middle = overlay(view, state["mask"], out.parent / "effect.png", state.get("paste_mask"))
    if state.get("edited"):
        after = Image.open(state["edited"]).convert("RGB")
        changed = metrics.change_map(view, after)
        changed.save(out.parent / "diff.png")
        _boxes(after, [i["region"] for i in report["issues"]], (230, 30, 30),
               [str(n + 1) for n in range(len(report["issues"]))])
    panels = ((before, "before, with the boxes the VLM gave"),
              (middle, "item (red), its shadow or glow (pink), paste area (blue line)"),
              (after, "after, with the issues numbered"),
              (changed, "what changed: |before - after| x4"))
    scale = tile / max(view.size)
    tw, th = round(view.size[0] * scale), round(view.size[1] * scale)
    lines = [f"{report['verdict'].upper()}: {report['summary']}   request: {state['request']}"]
    lines += [f"{n + 1}. [severity {i['severity']}, {i['source']}] {i['kind']}: {i['evidence']}  ->  {i['repair']}"
              for n, i in enumerate(report["issues"])]
    lines += [f"note [severity {i['severity']}] {i['kind']}: {i['evidence']}" for i in report["notes"]]
    lines.append("scores: " + ", ".join(f"{k} {v}" for k, v in report["scores"].items()))
    lines.append("seconds: " + ", ".join(f"{k} {v['seconds']}" for k, v in (state.get("timings") or {}).items()))
    font = ImageFont.load_default(14)
    wrapped = [part for line in lines for part in textwrap.wrap(line, width=max(40, len(panels) * tw // 8)) or [""]]
    img = Image.new("RGB", (len(panels) * tw, th + 24 + 19 * len(wrapped) + 12), (24, 24, 24))
    draw = ImageDraw.Draw(img)
    for col, (panel, name) in enumerate(panels):
        img.paste(panel.resize((tw, th), Image.LANCZOS), (col * tw, 24))
        draw.text((col * tw + 6, 4), name, fill=(255, 255, 0), font=font)
    for n, line in enumerate(wrapped):
        draw.text((8, th + 30 + 19 * n), line, fill=(235, 235, 235), font=font)
    img.save(out, quality=90)
    return out

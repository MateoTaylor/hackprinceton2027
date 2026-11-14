"""The checks for a change: did it land, does the thing keep its light, and did the model change the
light next to it.

A removal's checks do not fit. `visible_seam` measures the tone just inside the paste border, and a
change's paste border is the thing's own edge, which changed on purpose. `object_remains` is "the
masked area barely changed", which for a change is `not_applied`. The removal questions ask what is
still visible. Here:
- not_applied: for a recolour, by the hue that landed (no VLM); for any change, one VLM question on a
  close-up of the result alone (the VLM describes one picture reliably and compares two badly).
- shading_changed: the light and dark pattern on the thing no longer follows the photo's.
- shadow_left / light_left: the photo's own shadow or glow was kept, but the image model changed the
  light next to the thing. A warning for the second pass, which may paste the model's version.
- form_changed: the new outline is further from the old one than "a small change of form".
- wrong_picture: the image model returned another picture.
"""
import numpy as np
from PIL import Image

from edit_agent import metrics
from edit_agent.change import colour
from edit_agent.change.spec import label_of

LIMITS = {
    "wrong_picture_drift": 40.0,   # as config.Limits
    "unchanged_inside": 5.0,       # mean change inside the paste below this: nothing happened
    "hue_off": 35.0,               # degrees between the colour that landed and the asked colour
    "old_left": 0.15,              # share of the recoloured part that still has the old colour
    "shading": 0.55,               # correlation of the thing's light and dark pattern, photo vs result
    "effect_share": 0.02,          # share of the picture next to the thing where the model changed the light.
                                   # A removal's limit is 0.002, but a change always keeps the photo's light, and
                                   # the model redrawing what sits on the thing (the balls on a countertop: 1%)
                                   # is not light. Only a large relighting (a lamp's new light cones: 6%) counts.
    "form_iou": 0.80,              # Mateo, 2026-11-14: new outline overlaps the old by at least this
    "form_beyond": 0.05,           # and at most this share of it lies past the old box grown by 10%
}

REPAIRS = {
    "wrong_picture": "regenerate with a new seed",
    "not_applied": "regenerate with a clearer instruction or a new seed",
    "shading_changed": "regenerate with a new seed",
    "shadow_left": "paste the image model's picture over the thing's shadow too, if it looks right there",
    "light_left": "paste the image model's picture over the light next to the thing too, if it looks right there",
    "form_changed": "paste through the old outline only, or regenerate with 'keep its shape'",
}


def _corr(a, b):
    a, b = a - a.mean(), b - b.mean()
    den = float(np.sqrt((a * a).sum() * (b * b).sum()))
    return round(float((a * b).sum() / den), 3) if den > 0 else None


def _lightness(img, radius=0):
    """CIELAB lightness, blurred by about `radius` pixels (three box blurs)."""
    lab = colour.to_lab(np.asarray(img.convert("RGB")))[..., 0]
    return metrics.smooth(lab, max(1, round(radius))) if radius else lab


def measure(view, raw, edited, mask, paste_mask, target, preset, run, form=None, colour_info=None):
    """Numbers for flags(). `form` is new_outline's info, `colour_info` the paste's (the old hue)."""
    scores = metrics.measure(view, raw, edited, mask, paste_mask)
    scores = {k: scores[k] for k in ("drift_outside", "mask_share", "paste_share")}
    photo, result = Image.open(view).convert("RGB"), Image.open(edited).convert("RGB")
    out = Image.open(raw).convert("RGB").resize(photo.size, Image.LANCZOS)
    item = np.asarray(Image.open(mask).convert("L")) > 127
    paste = np.asarray(Image.open(paste_mask).convert("L")) > 127
    inner = metrics.shrunk(paste, 2)
    inner = inner if inner.sum() > 50 else paste
    scores["change_inside"] = round(float(np.abs(np.asarray(photo, np.float32) - np.asarray(result, np.float32))[paste].mean()), 2) if paste.any() else 0.0
    ys, xs = np.nonzero(item)
    span = ((xs.max() - xs.min()) + (ys.max() - ys.min())) / 2
    sigma = max(2.0, 0.04 * span)                             # the light on the thing, not its texture
    scores["shading"] = _corr(_lightness(photo, sigma)[inner], _lightness(result, sigma)[inner])
    if target["change"]["style"] == "recolor":                # a recolour keeps the fine light and dark detail too
        fine = lambda im: _lightness(im, 1.0) - _lightness(im, 4.0)
        scores["detail"] = _corr(fine(photo)[inner], fine(result)[inner])
        from_info = {k: v for k, v in (colour_info or {}).items() if k in ("hue", "chroma")}
        scores.update(colour.landed(result, paste, target["change"]["to"], from_info))
    effect, info = metrics.effect_region(photo, out, item, preset.limits)
    Image.fromarray(effect.astype(np.uint8) * 255).save(run / "effect.png")
    scores.update(effect_share=info["effect_share"], **{k: info[k] for k in ("effect_sign", "effect_box") if k in info})
    if form:
        scores.update({k: form[k] for k in ("form_iou", "form_beyond", "form_box") if k in form})
    return scores


CROP_MARGIN = 0.8   # a loose crop: at 0.3 the VLM missed a pillow half left teal (vlmtest, 2026-11-14)


def question(target):
    """The close-up question and its JSON shape, built from the change block. A recolour also asks
    whether the old colour is still visible; a change with `keep` asks whether those parts stayed.
    One picture per question: the VLM describes one picture well and compares two badly."""
    c = target["change"]
    name = colour.strip_colours(label_of(target)) or label_of(target)
    lines = ['- "looks": its colours and material, in a few words.',
             f'- "is_new": "yes" if it is {c["to"]}, "partly" if only some of it is, "no" if it is not.']
    props = {"looks": {"type": "string", "maxLength": 120},
             "is_new": {"type": "string", "enum": ["yes", "partly", "no"]}}
    if c["style"] == "recolor":
        lines.append(f'- "old_seen": "yes" if any part of it is still {c["from"]}, even thin lines or small patches; "no" if none is.')
        props["old_seen"] = {"type": "string", "enum": ["yes", "no"]}
    # No question about `keep`. Tested on 12 labelled pictures (vlmtest, 2026-11-14): "kept: yes/no" said
    # "no" on nearly every red pillow; "the colour of its grey pattern" came back "grey" even where it was
    # made red; without the colour word it described the whole pillow. The colour mask keeps them instead.
    lines.append('- "natural": "yes" if it looks like a real object lit by the same light as the room around it; '
                 '"no" if it looks flat, pasted on, glowing or lit from another side.')
    props["natural"] = {"type": "string", "enum": ["yes", "no"]}
    text = (f"This is a close-up of a photo of a room. Look at the {name} outlined in yellow; the outline is not part"
            " of the photo.\n\nAnswer with JSON:\n" + "\n".join(lines) + "\n")
    return text, {"title": "change_check", "type": "object", "properties": props, "required": list(props)}


def close_up(edited, box, run, margin=0.5, tag="check_crop", outline=None):
    """A crop around `box`. With `outline` (a bool mask of the picture), its edge is drawn in yellow:
    a thing behind another (a pillow behind a pillow) is otherwise not the one the VLM describes."""
    img = Image.open(edited).convert("RGB")
    if outline is not None:
        width = max(2, round(0.003 * max(img.size)))
        edge = metrics.grown(outline, width) & ~outline
        a = np.asarray(img).copy()
        a[edge] = (255, 230, 0)
        img = Image.fromarray(a)
    x0, y0, x1, y1 = box
    mx, my = margin * (x1 - x0), margin * (y1 - y0)
    crop = [int(max(0, x0 - mx)), int(max(0, y0 - my)), int(min(img.size[0], x1 + mx)), int(min(img.size[1], y1 + my))]
    path = run / f"{tag}.png"
    img.crop(crop).save(path)
    return path, crop


def parts(paste, most=3):
    """The boxes to ask about, one per changed thing: the largest separate parts of the paste, joined
    across small gaps. A union box of four pillows is the whole view, and the VLM then describes
    whatever is in its middle. The finder's boxes do not do either: they overlap, and a box can hold a
    pillow the recolour did not touch."""
    step = 4
    small = metrics.grown(paste, round(0.015 * max(paste.shape)))[::step, ::step]
    seen, out = np.zeros_like(small), []
    for y, x in zip(*np.nonzero(small)):
        if seen[y, x]:
            continue
        stack, comp = [(y, x)], []
        seen[y, x] = True
        while stack:
            cy, cx = stack.pop()
            comp.append((cy, cx))
            for ny, nx in ((cy - 1, cx), (cy + 1, cx), (cy, cx - 1), (cy, cx + 1)):
                if 0 <= ny < small.shape[0] and 0 <= nx < small.shape[1] and small[ny, nx] and not seen[ny, nx]:
                    seen[ny, nx] = True
                    stack.append((ny, nx))
        ys, xs = np.array(comp).T
        out.append((len(comp), [int(xs.min() * step), int(ys.min() * step), int((xs.max() + 1) * step),
                                int((ys.max() + 1) * step)]))
    total = sum(n for n, _ in out)
    return [b for n, b in sorted(out, key=lambda o: -o[0]) if n >= 0.1 * total][:most]


def inspect(server, preset, edited, target, paste_mask, run):
    """One close-up per changed thing; the worst answer counts."""
    from edit_agent.steps import look
    paste = np.asarray(Image.open(paste_mask).convert("L")) > 127
    text, schema = question(target)
    answers, info = [], {}
    joined = metrics.grown(paste, round(0.015 * max(paste.shape)))
    for i, box in enumerate(parts(paste)):
        x0, y0, x1, y1 = box
        part = np.zeros_like(paste)
        part[y0:y1, x0:x1] = paste[y0:y1, x0:x1]                       # this part's own pixels
        part = metrics.grown(part, round(0.012 * max(paste.shape))) & joined   # a loose marker, not a cut-out edge
        crop, where = close_up(edited, box, run, margin=CROP_MARGIN, tag=f"check_crop{i}", outline=part)
        answer, info = look(server, preset, [crop], text, schema, max_tokens=250)
        answers.append({**answer, "close_box": where})
    if not answers:
        return {}, info
    rank = {"no": 0, "partly": 1, "yes": 2}
    worst = min(answers, key=lambda a: (rank[a["is_new"]], a["natural"] == "yes"))
    out = {**worst, "natural": "no" if any(a["natural"] == "no" for a in answers) else "yes", "each": answers}
    if "old_seen" in worst:
        out["old_seen"] = "yes" if any(a.get("old_seen") == "yes" for a in answers) else "no"
    return out, info


def _issue(kind, severity, source, evidence, region=None):
    return {"kind": kind, "severity": severity, "source": source, "evidence": evidence, "region": region,
            "repair": REPAIRS[kind]}


def flags(scores, findings, target, limits=LIMITS):
    """The issues worth a second pass, most severe first."""
    out, change = [], target["change"]
    box = scores.get("paste_box")
    if scores["drift_outside"] > limits["wrong_picture_drift"]:
        out.append(_issue("wrong_picture", 3, "metric", f"the image model changed the whole picture (drift {scores['drift_outside']})"))
    if scores["change_inside"] < limits["unchanged_inside"]:
        out.append(_issue("not_applied", 3, "metric", f"the thing barely changed (mean change {scores['change_inside']})", box))
    elif scores.get("hue_off", 0) > limits["hue_off"]:
        out.append(_issue("not_applied", 3, "metric", f"the new colour is {scores['hue_off']} degrees of hue from {change['to']}", box))
    elif scores.get("old_left", 0) > limits["old_left"]:
        out.append(_issue("not_applied", 2, "metric", f"{scores['old_left']:.0%} of it still has the old colour", box))
    elif findings.get("is_new") in ("partly", "no"):
        out.append(_issue("not_applied", 3 if findings["is_new"] == "no" else 2, "vlm",
                          f"the VLM sees it as {findings.get('looks', '?')}", box))
    elif findings.get("old_seen") == "yes":
        out.append(_issue("not_applied", 2, "vlm", f"the VLM still sees {change['from']} on it", box))
    if scores.get("shading") is not None and scores["shading"] < limits["shading"]:
        out.append(_issue("shading_changed", 2, "metric", f"the light and dark on it follow the photo's at only {scores['shading']}", box))
    elif findings.get("natural") == "no":
        out.append(_issue("shading_changed", 2, "vlm", "the VLM says it looks flat, pasted on or lit differently", box))
    if scores.get("effect_share", 0) > limits["effect_share"]:
        brighter = scores.get("effect_sign", 0) > 0
        out.append(_issue("shadow_left" if brighter else "light_left", 2, "metric",
                          f"the image model made the area next to it {'brighter' if brighter else 'darker'} "
                          f"({scores['effect_share']:.1%} of the picture); the photo's own light there was kept",
                          scores.get("effect_box")))
    if "form_iou" in scores and (scores["form_iou"] < limits["form_iou"] or scores.get("form_beyond", 0) > limits["form_beyond"]):
        out.append(_issue("form_changed", 2, "metric", f"the new outline overlaps the old by {scores['form_iou']} "
                          f"and {scores.get('form_beyond', 0):.0%} of it is past the old box", scores.get("form_box")))
    return sorted(out, key=lambda i: -i["severity"])

"""The typed results that pass between steps, and the four questions the VLM is asked."""
from typing import Literal

from pydantic import BaseModel, Field

IssueKind = Literal["not_found", "object_remains", "not_applied", "shadow_left", "light_left", "color_mismatch",
                    "visible_seam", "damaged_neighbour", "wrong_picture"]

# What a second pass would do about each kind of issue. The second pass is not built yet.
REPAIRS = {
    "not_found": "rephrase the request or choose a view that shows the thing",
    "object_remains": "regenerate with an instruction that names what is left, or a new seed",
    "not_applied": "regenerate with a clearer instruction or a new seed",
    "shadow_left": "paste the image model's picture over the shadow if it is gone there; else mask the shadow and regenerate",
    "light_left": "paste the image model's picture over the lit surface if it is dark there; else mask it and regenerate",
    "color_mismatch": "tone-match a wider area; regenerate if it stays",
    "visible_seam": "paste a wider tone-matched area",
    "damaged_neighbour": "paste the neighbour's original pixels back on top",
    "wrong_picture": "regenerate with a new seed",
}


class Box(BaseModel):
    bbox_2d: list[int] = Field(min_length=4, max_length=4)       # 0-1000 scale, as Qwen3-VL writes boxes
    label: str


class Target(BaseModel):
    """What the locator found: the thing to edit and the instruction for the image model."""
    found: bool
    item: str
    kind: Literal["remove", "change"]
    boxes: list[Box]
    behind: str
    instruction: str


class Issue(BaseModel):
    kind: IssueKind
    severity: int = Field(ge=1, le=3)             # 1 faint, 2 clear at a glance, 3 the edit failed
    source: Literal["metric", "vlm"]
    evidence: str
    region: list[int] | None = None               # [x0, y0, x1, y1] in pixels of the working image
    repair: str


class QAReport(BaseModel):
    verdict: Literal["pass", "fix"]
    scores: dict[str, float]
    issues: list[Issue]                           # what a second pass should fix
    notes: list[Issue]                            # faint findings, kept for the record
    summary: str


_BOX = {"type": "array", "items": {"type": "integer"}, "minItems": 4, "maxItems": 4}
_LEVEL = {"type": "string", "enum": ["none", "faint", "clear"]}

# 1. Locate. The question tested in tools/qwen_test/agent_edit.py, plus "found".
LOCATE_SCHEMA = {
    "title": "target",
    "type": "object",
    "properties": {
        "found": {"type": "boolean"},
        "item": {"type": "string", "maxLength": 100},
        "kind": {"type": "string", "enum": ["remove", "change"]},
        "boxes": {"type": "array", "maxItems": 12, "items": {
            "type": "object",
            "properties": {"bbox_2d": _BOX, "label": {"type": "string", "maxLength": 60}},
            "required": ["bbox_2d", "label"]}},
        "behind": {"type": "string", "maxLength": 300},
        "instruction": {"type": "string", "maxLength": 300},
    },
    "required": ["found", "item", "kind", "boxes", "behind", "instruction"],
}

LOCATE_PROMPT = """The user asked for this edit to the photo: "{text}"

Answer with JSON:
- "found": true if the thing to edit is visible in the photo, false if it is not (then "boxes" is empty).
- "item": the thing to edit, named with its colour and material, at most 12 words. If the edit applies to several things, name each of them.
- "kind": "remove" if the thing should disappear, "change" if it stays but looks different.
- "boxes": locate every object the edit applies to. One entry per object, with "bbox_2d": [x1, y1, x2, y2] and a short "label". A box must contain the whole object, including things that sit on it and would go with it.
- "behind": one sentence describing the surfaces behind and under the thing (wall colour, floor material, baseboard), to be drawn where it is removed.
- "instruction": the user's edit rewritten as one clear sentence for an image editing model. It names every object the edit applies to, each with its colour, and says what happens to each one."""


def edit_prompt(target):
    """The text the image model gets, built from the locator's answer."""
    text = target.instruction.strip()
    if not text.endswith("."):
        text += "."
    if target.kind == "remove":
        text += (" Remove the shadow it casts and its reflection too."
                 f" Show what is behind it: {target.behind.strip().rstrip('.')}.")
    else:
        text += " Keep its shape, position and shading."
    return text + " Keep everything else in the image exactly the same."


# The check is short questions with fixed answers. Two things were learned by testing on edits of
# known quality: an open "list the issues" question makes the VLM write the same faint shadow for
# every picture, and when it compares two whole pictures it misses tone problems and sometimes says
# a removal is done while the thing is still there. It describes a single picture reliably. So a
# removal is checked on a close-up of the result alone (questions 3 and 4), and the comparison
# (question 2) decides only whether a change was applied and whether a neighbour was damaged.

# 2. Compare before and after, judged against the user's own words.
COMPARE_SCHEMA = {
    "title": "comparison",
    "type": "object",
    "properties": {
        "changed": {"type": "string", "maxLength": 240},
        "done": {"type": "string", "enum": ["yes", "partly", "no"]},
        "neighbours": {"type": "string", "enum": ["unchanged", "changed"]},
        "worst": {"type": "string", "maxLength": 160},
    },
    "required": ["changed", "done", "neighbours", "worst"],
}

COMPARE_PROMPT = """The first image is a photo of a room. The second image is the same photo after an edit. The user asked for: "{request}"
The thing to edit was: {item}. In the first image it is inside the box {box} (0-1000 scale).

Compare the two images. Judge at a glance, the way a visitor to the room would. Ignore small differences in texture, grain or sharpness.

Answer with JSON:
- "changed": one sentence saying what is different in the second image.
- "done": "yes" if everything the user asked for was carried out (for a removal: nothing of the thing is visible any more), "partly" if some of it remains, "no" if nothing changed.
- "neighbours": "changed" if another object next to the thing was altered, cut or removed, otherwise "unchanged".
- "worst": one short sentence about the most visible problem, or an empty string if there is none."""

# 3. After a removal: which of the things can still be seen in a close-up of the result?
VISIBLE_PROMPT = """Look at this photo of part of a room.

Answer with JSON:
- "objects": one sentence listing the objects you can see in the photo.
- "visible": from this list, the things you can see in the photo: {labels}. An empty list if you can see none of them."""


def visible_schema(labels):
    """The answer may only name things the locator found."""
    return {
        "title": "visible",
        "type": "object",
        "properties": {"objects": {"type": "string", "maxLength": 200},
                       "visible": {"type": "array", "maxItems": len(labels),
                                   "items": {"type": "string", "enum": labels}}},
        "required": ["objects", "visible"],
    }


# 4. After a removal: what did it leave on the wall and floor? The same close-up.
# The wording says "room, wall and floor" although views can be outdoors, and it stays that way: a
# wording with no kind of place ("the surfaces around it: the ground or the floor ...") was tried on
# the five edits of known quality and answered "none" to everything, the bad paste included. On a
# street the VLM describes the scene wrongly with this wording and finds no shadows with either.
SURFACE_SCHEMA = {
    "title": "surface",
    "type": "object",
    "properties": {"surface": {"type": "string", "maxLength": 200}, "patch": _LEVEL, "shadow": _LEVEL, "glow": _LEVEL},
    "required": ["surface", "patch", "shadow", "glow"],
}

SURFACE_PROMPT = """An object was digitally removed from the middle of this photo of a room. Look at the wall and the floor.

Answer with JSON:
- "surface": one sentence describing how the wall and floor look.
- "patch": is there a rectangular or blob-shaped area whose brightness or colour differs from the wall around it, like a pasted patch? "none", "faint" or "clear".
- "shadow": is there a shadow or dark silhouette on the wall or floor with no object there to cast it? "none", "faint" or "clear".
- "glow": is there a bright glow on the wall or floor, as if from a lamp, with no lamp there? "none", "faint" or "clear"."""

# How each grade becomes a finding: (field, grade) -> (kind, severity, what it means)
GRADES = {
    ("patch", "clear"): ("color_mismatch", 2, "a patch of different brightness or colour shows where the thing was"),
    ("patch", "faint"): ("color_mismatch", 1, "a faint patch shows where the thing was"),
    ("shadow", "clear"): ("shadow_left", 2, "a shadow with nothing to cast it is clearly visible"),
    ("shadow", "faint"): ("shadow_left", 1, "a faint shadow is left"),
    ("glow", "clear"): ("light_left", 2, "a glow with no lamp to cause it is clearly visible"),
    ("glow", "faint"): ("light_left", 1, "a faint glow is left"),
    ("neighbours", "changed"): ("damaged_neighbour", 2, "an object next to the thing was altered"),
}

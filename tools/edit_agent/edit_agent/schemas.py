"""The typed results that pass between steps, and the five questions the VLM is asked."""
import json
import re
from typing import Literal

from pydantic import BaseModel, Field

IssueKind = Literal["not_found", "object_remains", "object_added", "not_applied", "shadow_left", "light_left",
                    "color_mismatch", "visible_seam", "damaged_neighbour", "wrong_picture", "shading_changed",
                    "form_changed"]

# What a second pass would do about each kind of issue. Built so far (graph.repair): `damaged_neighbour`
# at a scouted place, `object_remains` and `object_added` that the VLM named, and a new seed for an edit that failed outright
# (`wrong_picture`, a severity-3 `not_applied`). The others are still words. A change's issues come from
# change/checks.py, with that file's own words (change/checks.REPAIRS).
REPAIRS = {
    "not_found": "rephrase the request or choose a view that shows the thing",
    "object_remains": "remove what is left from the result: find it by name, cut it out and redraw it (about 40 s)",
    "object_added": "remove what the image model drew: find it by name inside the paste area, cut it out and redraw it (about 40 s)",
    "not_applied": "regenerate with a clearer instruction or a new seed",
    "shadow_left": "paste the image model's picture over the shadow if it is gone there; else mask the shadow and regenerate",
    "light_left": "paste the image model's picture over the lit surface if it is dark there; else mask it and regenerate",
    "color_mismatch": "tone-match a wider area; regenerate if it stays",
    "visible_seam": "paste a wider tone-matched area",
    "damaged_neighbour": "put the original's detail back there, in the tone of the edit around it",
    "wrong_picture": "regenerate with a new seed",
    "shading_changed": "regenerate with a new seed",
    "form_changed": "paste through the old outline only, or regenerate with 'keep its shape'",
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
    change: dict | None = None    # for a change: {style, from, to, keep, form} (change/spec.py); filled by the graph


class Issue(BaseModel):
    kind: IssueKind
    severity: int = Field(ge=1, le=3)             # 1 faint, 2 clear at a glance, 3 the edit failed
    source: Literal["metric", "vlm"]
    evidence: str
    region: list[int] | None = None               # [x0, y0, x1, y1] in pixels of the working image
    repair: str
    action: Literal["restore", "remove_again", "regenerate"] | None = None   # what the second pass does by itself;
                                                                              # None = only reported
    what: str | None = None                       # for remove_again: the names of what is left, for the locator
    missed: bool = False                          # for remove_again: the locator never found it, so it is looked for
                                                  # by name anywhere, not only inside the first paste


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
- "boxes": locate every object the edit applies to. One entry per object, with "bbox_2d": [x1, y1, x2, y2] around that whole object and a short "label" naming that one object. For a removal, add a separate entry for each thing that rests on top of a removed object (a lamp, a vase, a tray, a pillow), because it goes with it. Things on the wall above or behind it (a picture, a mirror, a wall hanging) do not rest on it: they stay and get no entry.
- "behind": one sentence describing the surfaces behind and under the thing (wall colour, floor material, baseboard), to be drawn where it is removed.
- "instruction": the user's edit rewritten as one clear sentence for an image editing model. It names every object the edit applies to, each with its colour, including each thing that rests on top of a removed object, and says what happens to each one."""


# 1b. After a removal is located: a second look, on a close-up of what was found, that only lists the
# separate things it takes. The 8B VLM's first answer often draws one box around a table and what is
# on it, or drops some of the things: in 5 of 13 stored views it gave one box for "the dresser and
# everything on it", or left out the vases or the tray. Then the cut-out misses them and they are left
# floating. The answer is merged into the first one; boxes that repeat one already found are dropped.
THINGS_SCHEMA = {
    "title": "things",
    "type": "object",
    "properties": {"boxes": LOCATE_SCHEMA["properties"]["boxes"]},
    "required": ["boxes"],
}

THINGS_PROMPT = """The user asked for this edit to the photo: "{text}"
This photo is a close-up of where the edit happens. Found so far: {labels}.

Answer with JSON:
- "boxes": every separate object the edit removes, one entry per object, with "bbox_2d": [x1, y1, x2, y2] around that whole object and a short "label" naming that one object. List:
  each thing the user's words name to remove;
  each thing that rests on top of a removed object (a lamp, a vase, a tray, a book, a pillow), because it would float without it;
  when the user says "everything on" a piece of furniture, each object standing on its top.
  Do not list the furniture the user says the things are on, unless the user asks to remove it too. Do not list things fixed to the wall or hanging above (a picture, a mirror, a wall hanging), nor things that only stand beside a removed object."""


def edit_prompt(target):
    """The text the image model gets, built from the locator's answer."""
    text = target.instruction.strip()
    if not text.endswith("."):
        text += "."
    if target.kind == "remove":
        # `target.behind` (the VLM's words for the wall and floor) is not passed on. The image model sees
        # the picture itself, and a wrong description is obeyed: "gray wall, no baseboard" repainted a
        # white wall grey and deleted its baseboard.
        text += " Remove the shadow it casts and its reflection too."
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


# 3b. After a removal: is something left floating? The same close-up. A removal that takes a piece of
# furniture and misses what stood on it leaves that thing in the air. Asked on the 33 stored close-ups,
# it named the vase in 2 of the 3 runs that left one floating and nothing in the other 30, nor in any of
# the 33 originals. The VLM explains some leftovers away: the third run's lamp "hangs from a wall
# mount". Something it names is asked about again on the original (a pendant lamp is held by a cord
# the VLM may not see), and only what floats in the result alone counts.
FLOAT_SCHEMA = {
    "title": "floating",
    "type": "object",
    "properties": {"objects": {"type": "string", "maxLength": 240},
                   "floating": {"type": "array", "maxItems": 4, "items": {"type": "string", "maxLength": 40}}},
    "required": ["objects", "floating"],
}

FLOAT_PROMPT = """Look at this photo of part of a room.

Answer with JSON:
- "objects": one sentence listing the objects you can see, and for each one what holds it up (it stands on the floor, on a table, on a shelf; it hangs from a cord or a hook; it is fixed to the wall or the ceiling).
- "floating": the objects that hang in the air with nothing you can see holding them up: no table or shelf under them, no cord, chain or bracket above them. Short names. An empty list if there are none."""


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

# 5. A place the scout marked (scout.py): what is inside the red box? Asked once on a crop of the
# original and once on the same crop of the result; the two answers are compared in code (report.py).
# Asked as one comparison of the two crops, the VLM answered "nothing is gone" for everything, a
# deleted baseboard included. Asked this way on 19 places of known quality it named the deleted
# baseboard as trim in 4 of 4, and a rightly removed shadow as a shadow in 6 of 6 (street pictures).
PLACE_SCHEMA = {
    "title": "place",
    "type": "object",
    "properties": {"inside": {"type": "string", "maxLength": 80},
                   "kind": {"type": "string", "enum": ["target", "shadow", "trim", "object", "surface"]}},
    "required": ["inside", "kind"],
}

PLACE_PROMPT = """Look at this photo of part of a room. A red box marks one place.

Answer with JSON:
- "inside": what is inside the red box, at most 8 words.
- "kind": what the red box mostly holds:
  "target" if it is part of this: {item}
  "shadow" if it is a shadow or a dark reflection lying on a surface
  "trim" if it is a baseboard, a frame of a door or window, a moulding or a step
  "object" if it is another thing or piece of furniture
  "surface" if it is plain wall, floor or ground"""


# 5b. The control for an object that went at a scouted place: was it a separate thing (put it back) or a
# part of the removed one (leave it)? Asked on the original crop with the removed thing outlined in green,
# because asked by name alone the VLM took a removed armchair's own leg for a table leg. A thing that stood
# on the removed one goes with it, as LOCATE_PROMPT says, so "on" is not put back either: with only
# "part" and "separate", vases that stood on a removed dresser were called separate and put back.
OWN_SCHEMA = {
    "title": "own",
    "type": "object",
    "properties": {"red": {"type": "string", "maxLength": 80},
                   "belongs": {"type": "string", "enum": ["part", "on", "separate"]}},
    "required": ["red", "belongs"],
}

OWN_PROMPT = """Look at this photo of part of a room. A green line outlines one object: {item}. A red box marks one place.

Answer with JSON:
- "red": what is inside the red box, at most 8 words.
- "belongs": "part" if the thing in the red box is part of the object in the green outline (a leg, an edge, a shade, a cord or anything attached to it), "on" if it stands or lies on top of that object (a lamp, a vase, a tray, a pillow), "separate" if it is a different thing that does not rest on it (a vent, a rail, a socket, a picture, a piece of furniture next to it)."""

# 5c. Does a boxed thing stand on the request's place ("on the dresser")? Asked on the whole picture with
# the thing boxed in red, by first naming what is under it. The 8B VLM boxed the tray on the bed beside a
# dresser for "everything on the dresser"; asked "does it rest on the dresser?" on a close-up it said yes,
# asked what is under it on the whole room it said "bed" (18 things on their place still said "on").
# Asked on a result, "floats" catches a piece left in the air (a lamp shade whose base went), and a thing
# whose base the removed things hid is seen standing where it does (a plant pot on the floor behind a vase).
BELONG_SCHEMA = {
    "title": "belong",
    "type": "object",
    "properties": {"red": {"type": "string", "maxLength": 80}, "under": {"type": "string", "maxLength": 60},
                   "belongs": {"type": "string", "enum": ["part", "on", "floats", "separate"]}},
    "required": ["red", "under", "belongs"],
}

BELONG_PROMPT = """Look at this photo of a room. A red box marks one thing.

Answer with JSON:
- "red": what is inside the red box, at most 8 words.
- "under": the surface the thing in the red box stands or lies on, directly beneath it, at most 6 words, or "nothing" if nothing holds it up.
- "belongs": "on" if that surface is {anchor}, or is something that itself rests on {anchor} (a tray, a book, a stand); "part" if the thing in the red box is part of {anchor} itself (a leg, a top, a drawer, a handle); "floats" if it hangs in the air with nothing beneath it holding it up; "separate" if it stands, lies or hangs on anything else (the floor, a wall, a bed, a sofa, a rug, another piece of furniture)."""


_NOTHING = re.compile(r"^\W*(?:nothing|none|air|no surface)\b")


def taken(answer, req, on=()):
    """Whether a BELONG_PROMPT answer puts the thing among what the request takes from its place.

    The VLM's own verdict ("belongs") is not trusted: about the tray on a bed it wrote under "bed" and
    belongs "on" in one answer, and one changed word in the prompt flipped it. What it names under the
    thing was right in 27 of 27 answers, so that decides: the place's noun in it ("top of dark wooden
    dresser", "bedspread"), or a thing already taken from the place (`on`, nouns: "teal tray" under a
    vase), or nothing (a piece left in the air). A "part" of a place that stays is never taken.
    """
    if req["kept"] and answer["belongs"] == "part":
        return False
    under = answer["under"].lower()
    if _NOTHING.match(under):
        return True
    return head(req["anchor"]) in re.sub(r"[^a-z]", "", under) or head(under) in set(on)


_JOINS = re.compile(r"\b(?:with|and|on|in|of|from|under|beside|next to|behind)\b|[,;()]")


def name_words(text):
    """The words of a short name, singular, to compare two names: "grey vases" -> {"grey", "vase"}."""
    return {w.removesuffix("s") for w in re.findall(r"[a-z]+", text.lower()) if len(w) > 2}


def head(label):
    """The noun a label is about: the last word before its first "on", "with" ...: "grey vase on tray" -> "vase"."""
    words = re.findall(r"[a-z]+", _JOINS.split(label.lower())[0])
    return words[-1].removesuffix("s") if words else ""


_WHERE = re.compile(r"\b(?:on|in|of|from|under|beside|next to|behind|above|below)\b|[(;]")
_LIST = re.compile(r"\band\b|,")


def parts(label):
    """The separate things one label names, for asking which are still visible.

    The locator sometimes gives one label for several things: "coffee table with tray and vase".
    Asked whether that is still visible, the VLM said no while the vase floated in mid-air. So a list
    after "with" counts as more things, but a single word after it is a part ("lamp with glass base")
    and what comes after "on", "beside" ... is only where the thing is ("vase on tray").
    """
    text = _WHERE.split(label.lower())[0]
    first, _, rest = text.partition(" with ")
    names = _LIST.split(first)
    if _LIST.search(rest):
        names += _LIST.split(rest)
    names = [name.strip() for name in names]
    # "fan with white and dark wood blades": a name of only colours and materials describes the next one
    return [name for name in names if name and not set(name.split()) <= _LOOKS]


_LOOKS = {"white", "black", "grey", "gray", "brown", "beige", "cream", "tan", "red", "orange", "yellow", "green",
          "teal", "blue", "navy", "purple", "pink", "gold", "golden", "silver", "dark", "light", "pale", "bright",
          "wood", "wooden", "metal", "metallic", "glass", "ceramic", "brass", "chrome", "velvet", "leather",
          "textured", "patterned", "striped", "small", "large", "tall", "short", "round", "square"}


# The request, read without a model. The locator's names are no evidence about what the locator missed,
# so the check also asks about the request's own words (REQUEST_PROMPT), the way the retexture check
# asks whether the thing now looks as the request says.
EVERY = re.compile(r"\b(?:everything|all|clutter|stuff|things|items|anything|whatever)\b")
WHERE_WORDS = re.compile(r"\b(?:on|in|of|from|off|under|beside|next to|behind|above|below|at)\b")
_FILLER = {"remove", "delete", "erase", "take", "out", "away", "get", "rid", "clear", "please", "the", "a", "an", "its",
           "their", "this", "that", "these", "those", "some", "both", "one", "two", "three", "four", "five"}


def read_request(request):
    """What a removal request names, where, and whether it says "everything".

    "remove the tray and the throw pillows from the bed": names tray, throw pillows; at "on the bed"
    "remove everything on the coffee table": no names, every; anchor "the coffee table", which stays
    "remove the dresser and everything on it": names dresser, every; anchor "the dresser", which goes
    The anchor is what everything else taken must stand on (or be part of, when it goes too). `prep` is the
    place's word; only "on" (or "from", "off") makes the anchor a surface that BELONG_PROMPT can ask about.
    """
    text = request.lower().strip().rstrip(".!")
    m = WHERE_WORDS.search(text)
    first, prep, where = (text[:m.start()], m.group(0), text[m.end():].strip()) if m else (text, "", "")
    names = []
    for piece in re.split(r"\band\b|,", first):
        words = [w for w in re.findall(r"[a-z]+", piece) if w not in _FILLER]
        if words and not EVERY.search(" ".join(words)):
            names.append(" ".join(words))
    every = bool(EVERY.search(first))
    pronoun = where in ("it", "them")
    if pronoun and names:
        anchor, kept = f"the {names[0]}", False
    elif where and not pronoun:
        anchor, kept = where, head(where) not in {head(n) for n in names}
    else:
        anchor, kept = "", False
    prep = "on" if prep in ("from", "off") else prep
    return {"names": names, "every": every, "at": f"{prep} {where}" if where and not pronoun else "",
            "anchor": anchor, "kept": kept, "prep": prep if anchor else ""}


def request_question(req):
    """The question about the request's own words, asked on the whole original and the whole result.

    "count" checks each thing the request names; the original's count is the control. "on" lists what
    stands on a place that stays ("on the bed"), to see what went that the request did not name.
    """
    at = f" {req['at']}" if req["at"] else ""
    lines = [f'- "objects": one sentence listing the objects you can see{at}.']
    props = {"objects": {"type": "string", "maxLength": 240}}
    if req["names"]:
        lines.append(f'- "count": for each of these things, how many you can see{at}, 0 if none: {json.dumps(req["names"])}.')
        props["count"] = {"type": "object", "properties": {n: {"type": "integer"} for n in req["names"]},
                          "required": req["names"]}
    if req["kept"]:
        # the locator's wording: in one dresser view the VLM listed the art on the wall behind the vases
        lines.append(f'- "on": short names of the separate things {req["at"]}, one entry per thing, not '
                     f'{req["anchor"]} itself. Things on the wall above or behind it (a picture, a mirror, a wall '
                     f'hanging) are not on it: leave them out. An empty list if there are none.')
        props["on"] = {"type": "array", "maxItems": 8, "items": {"type": "string", "maxLength": 40}}
    text = "Look at this photo of a room.\n\nAnswer with JSON:\n" + "\n".join(lines)
    return text, {"title": "request", "type": "object", "properties": props, "required": list(props)}


def request_findings(req, before, after, boxed=()):
    """What the answers about the request's words mean: (kind, severity, evidence, action, what) tuples.

    A named thing counts only if the VLM saw it in the original too. It is left if the result still
    shows one (plural names) or as many as before (a singular name: "the lamp" where there are two).
    That orders a second removal only for a name the locator never boxed (`boxed`: the nouns of its
    labels), which is the blind spot this question is for. Leftovers of what it boxed are the label
    check's and the scout's; here they are a note, because the VLM's counts blur close kinds: it counted
    the plain sleeping pillows left on a bed as "throw pillows" after every throw pillow had gone.
    With "everything on" a place that stays, a thing on it in the result that was on it before is left,
    and one that was not is new: the image model drew it (a tray with a box on a cleared dresser, after
    its prompt named a tray elsewhere in the room). Both go again; graph.remove_again takes a new one
    only inside the paste area, so a thing the VLM left out of its first list stays.
    With named things, a thing on the place that went and was not named is a note: taken without being
    asked (the throw blanket under the pillows), or a false alarm (a book that lay on the removed tray,
    a stool beside the nightstand that the VLM listed as on it).
    """
    out, named = [], {head(n) for n in req["names"]}
    for name in req["names"]:
        b = int((before.get("count") or {}).get(name) or 0)
        a = int((after.get("count") or {}).get(name) or 0)
        plural = name.endswith("s") and not name.endswith("ss")
        if b >= 1 and (a >= 1 if plural else a >= b):
            evidence = f"the request names the {name}: {b} in the original, {a} in the result"
            if head(name) in boxed:
                out.append(("object_remains", 1, evidence + " (the locator boxed some)", None, None))
            else:
                out.append(("object_remains", 3, evidence + ", and the locator never boxed one", "remove_again",
                            f"{name} {req['at']}".strip()))
    if req["kept"] and "on" in before and "on" in after:
        had, has = {head(x) for x in before["on"]}, {head(x) for x in after["on"]}
        own = head(req["anchor"])
        if req["every"]:
            on = [x for x in dict.fromkeys(after["on"]) if head(x) != own]
            left = [x for x in on if head(x) in had]
            new = [x for x in on if head(x) not in had]
            if left:
                out.append(("object_remains", 3, f"still {req['at']}: {', '.join(left)}", "remove_again",
                            f"{' and the '.join(left)} {req['at']}"))
            if new:
                out.append(("object_added", 3, f"new {req['at']}, not there before: {', '.join(new)}",
                            "remove_again", f"{' and the '.join(new)} {req['at']}"))
        else:                       # what the locator boxed is no excuse: the blanket was boxed with the pillows
            gone = [x for x in before["on"] if head(x) not in has | named | {own}]
            if gone:
                out.append(("damaged_neighbour", 1, f"{', '.join(gone)} {req['at']} went, and the request did not "
                                                    "name it", None, None))
    return out


def place_finding(place, removal=True, labels=()):
    """What a scouted place means, from the VLM's two answers: (kind, severity, evidence, action, what) or None.

    On a removal, the result must not hold the thing any more. A place whose result the VLM names as
    part of it is a leftover (a vase left floating when the table under it went), and so is another
    object there that the VLM calls by the noun of one of the locator's labels.
    Trim that was there and is not there now is put back. A shadow that went is what was asked for.
    An object that went is put back only when the control (OWN_PROMPT, in `place["own"]`) says it is a
    separate thing; otherwise it is a note.
    """
    before, after = place["before"], place["after"]
    if removal and after["kind"] == "target":
        return ("object_remains", 2, f"part of what was to go is still there: '{after['inside']}' "
                                     f"(before: '{before['inside']}')", "remove_again", after["inside"])
    # A leftover was there before. An object where the original showed surface is new or misnamed: the
    # white glass top of a kept coffee table was called "white oval tray", and the table was removed.
    if removal and after["kind"] == "object" and before["kind"] in ("target", "object"):
        same = name_words(after["inside"]) & {head(label) for label in labels}
        if same:
            return ("object_remains", 2, f"'{after['inside']}' is still there, and the things to remove "
                                         f"included: {', '.join(sorted(same))}", "remove_again", after["inside"])
    if place["kind"] == "edges_lost" and before["kind"] == "trim" and after["kind"] != "trim":
        return ("damaged_neighbour", 2, f"'{before['inside']}' was removed with the item; the place now shows "
                                        f"'{after['inside']}'", "restore", None)
    if place["kind"] == "edges_lost" and before["kind"] == "object" and after["kind"] in ("surface", "shadow"):
        if (place.get("own") or {}).get("belongs") == "separate":
            return ("damaged_neighbour", 2, f"'{before['inside']}' was removed with the item; the place now shows "
                                            f"'{after['inside']}'", "restore", None)
        return ("damaged_neighbour", 1, f"'{before['inside']}' may have been removed with the item; the place now "
                                        f"shows '{after['inside']}'", None, None)
    if place["kind"] == "edges_new" and before["kind"] == "surface" and after["kind"] == "object":
        return ("object_added", 1, f"something new was drawn on '{before['inside']}': '{after['inside']}'",
                None, None)
    return None


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

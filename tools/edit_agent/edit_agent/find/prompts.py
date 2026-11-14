"""The questions the finder asks the VLM. Every answer has a fixed shape (JSON schema)."""
import json

from edit_agent.schemas import LOCATE_SCHEMA

# 1. Pointer: what did the user click? The answer has the shape of the edit side's locate answer,
#    so it becomes a `target` without translation. The first box is the clicked object.
POINT_SCHEMA = LOCATE_SCHEMA

_RING = "The circle is drawn on the photo to show the click; it is not part of the room."
_WHERE = {
    "both": "The user clicked at [{x}, {y}] (0-1000 scale); the click is marked with a red circle. " + _RING,
    "ring": "The user clicked on the spot marked with a red circle. " + _RING,
    "coords": "The user clicked at [{x}, {y}] (0-1000 scale).",
}

POINT_PROMPT = """This is a photo of a room. {where}
{words}

Answer with JSON:
- "found": true if there is an object at the click that the edit can apply to, false if the click is on empty wall, floor or ceiling and the edit is a removal (then "boxes" is empty).
- "item": the object at the click, named with its colour and material, at most 12 words. Name the whole object (the lamp, not its shade; the pillow, not the sofa it lies on), unless the user's words name a part or a larger thing. If the click is on a shadow or a reflection, the object is the one that casts it.
- "kind": "remove" if the thing should disappear, "change" if it stays but looks different.
- "boxes": the first entry is the object at the click, with "bbox_2d": [x1, y1, x2, y2] around the whole object and a short "label". For a removal, add a separate entry for each thing that sits on the object (a lamp on a table, pillows on a sofa), because they would go with it. Add a separate entry for each other object the user's words name.
- "behind": one sentence describing the surfaces behind and under the thing (wall colour, floor material, baseboard), to be drawn where it is removed.
- "instruction": the edit as one clear sentence for an image editing model. It names every object the edit applies to, each with its colour, and says what happens to each one."""


def point_prompt(point, request, marker):
    where = _WHERE[marker].format(x=round(point[0]), y=round(point[1]))
    if request:
        words = f'The user said: "{request}". Words like "this", "that" or "it" mean the object at the click.'
    else:
        words = "The user wants to remove the object at the click."
    return POINT_PROMPT.format(where=where, words=words)


# 2. Pointer fallback: SAM's outline of the click disagrees with the VLM's box. Describe the outlined
#    thing instead, in a crop around it. One picture, fixed fields: what the VLM does reliably.
DESCRIBE_SCHEMA = {
    "title": "outlined",
    "type": "object",
    "properties": {
        "object": {"type": "boolean"},
        "item": {"type": "string", "maxLength": 100},
        "label": {"type": "string", "maxLength": 60},
        "kind": {"type": "string", "enum": ["remove", "change"]},
        "behind": {"type": "string", "maxLength": 300},
        "instruction": {"type": "string", "maxLength": 300},
    },
    "required": ["object", "item", "label", "kind", "behind", "instruction"],
}

DESCRIBE_PROMPT = """This is part of a photo of a room. A red line outlines what the user clicked on; the line is drawn on the photo and is not part of the room, and everything outside it is darkened. Describe only what is inside the line. The outline can hold one object or a few that belong together (a lamp with its shade, a table with a lamp on it): name everything inside it, not one part.
{words}

Answer with JSON:
- "object": true if the outline holds a thing that could be taken out of the room or restyled (furniture, decor, a fixture, a countertop, a rug); false if it holds only bare wall, floor, ceiling or a shadow.
- "item": everything inside the outline, named with colour and material, at most 12 words.
- "label": a short plain name for everything inside the outline, two to four words (for example "table lamp", or "side table and lamp" when both are outlined).
- "kind": "remove" if it should disappear, "change" if it stays but looks different.
- "behind": one sentence describing the surfaces behind and under it (wall colour, floor material, baseboard), to be drawn where it is removed.
- "instruction": the edit as one clear sentence for an image editing model, naming the object with its colour and saying what happens to it."""


def describe_prompt(request):
    if request:
        words = f'The user said: "{request}". Words like "this", "that" or "it" mean the outlined object.'
    else:
        words = "The user wants to remove the outlined object."
    return DESCRIBE_PROMPT.format(words=words)


# 3. Search without a click. Closed questions with fixed answers: what the 8B VLM does reliably.
SEEN_SCHEMA = {
    "title": "seen",
    "type": "object",
    "properties": {"visible": {"type": "boolean"}, "what": {"type": "string", "maxLength": 80}},
    "required": ["visible", "what"],
}

SEEN_PROMPT = """This is a photo of part of a room. The user asked: "{request}"

Answer with JSON:
- "visible": true if the thing this request is about can be seen in this photo, even in part; false if not.
- "what": that thing as you see it, at most 8 words, or "" when it is not visible."""


def seen_prompt(request):
    return SEEN_PROMPT.format(request=request)


NAMES_SCHEMA = {
    "title": "names",
    "type": "object",
    "properties": {"names": {"type": "array", "maxItems": 20, "items": {"type": "string", "maxLength": 40}}},
    "required": ["names"],
}

NAMES_PROMPT = """This is a photo of part of a room. List the things in it that someone could remove or restyle: furniture, decor, plants, lamps, fixtures, appliances, rugs, countertops. Not walls, floor, ceiling, doors or windows.

Answer with JSON:
- "names": each thing once, two to four words with its colour or material (for example "grey sofa", "white table lamp", "green ceramic jar"). At most 20, the largest first."""


def match_schema(names):
    return {
        "title": "matches",
        "type": "object",
        "properties": {"matches": {"type": "array", "maxItems": len(names), "items": {"type": "string", "enum": names}}},
        "required": ["matches"],
    }


MATCH_PROMPT = """The user asked for this edit to a room: "{request}"

Here are the things seen in the room: {names}.

Answer with JSON:
- "matches": the things from this list that the request could be about. Several when several could fit (all the pillows for "the pillow"). An empty list if none fits."""


def match_prompt(request, names):
    return MATCH_PROMPT.format(request=request, names=json.dumps(names))

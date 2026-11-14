"""The `change` block of a target, and the VLM question that fills it from the request and the view.

  {"style": "recolor" | "restyle", "from": "blue", "to": "red", "keep": "grey piping", "form": "none" | "small"}

`style` recolor: only the colour changes, and the colour guardrail applies. restyle: the material,
finish or style changes, with no colour rule. `form` small: the outline may change a little (a more
modern lamp). `keep` names parts of the thing itself that stay as they are; never the room.
"""
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class Change(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    style: Literal["recolor", "restyle"]
    from_: str = Field(alias="from", max_length=40)
    to: str = Field(max_length=40)
    keep: str = Field("", max_length=80)
    form: Literal["none", "small"] = "none"

    def block(self):
        return self.model_dump(by_alias=True)


SPEC_PROMPT = """This is part of a photo of a room. The user asked: "{request}". The thing to change is the {label}{where}.

Answer with JSON about that thing only:
- "style": "recolor" if only its colour changes (for example "make the pillows red"); "restyle" if its material, finish or style changes (for example "make the countertop wood", "make this lamp more modern").
- "from": for a recolor, the one colour of it that changes, one or two words ("teal", "dark blue"), as seen in the photo; other colours on it go in "keep". For a restyle, its material or style now, one to three words.
- "to": what it becomes, in the user's words, one to four words ("red", "light oak wood", "more modern").
- "keep": parts of the thing itself that are a different colour or material and must stay as they are (a pattern, piping, legs, a frame), in a few words; "" if there are none. Never name the wall, the floor, the light or other things in the room.
- "form": read the request "{request}" again. "small" if it asks for a different style, look or design ("more modern", "rounder", "simpler", "fancier"): then the shape may change a little. "none" if it only names a new colour or material ("red", "wood", "marble").
"""

SPEC_SCHEMA = {
    "title": "change",
    "type": "object",
    "properties": {
        "style": {"type": "string", "enum": ["recolor", "restyle"]},
        "from": {"type": "string", "maxLength": 40},
        "to": {"type": "string", "maxLength": 40},
        "keep": {"type": "string", "maxLength": 80},
        "form": {"type": "string", "enum": ["none", "small"]},
    },
    "required": ["style", "from", "to", "keep", "form"],
}


def label_of(target):
    """The thing's short name: the first box label, else the item words."""
    labels = list(dict.fromkeys(b["label"] for b in target.get("boxes", []) if b.get("label")))
    return labels[0] if len(labels) == 1 else (target.get("item") or (labels[0] if labels else "thing"))


def describe(server, preset, crop, request, target):
    """Fill the change block with one VLM question about a close-up of the thing."""
    from edit_agent.steps import look
    text = SPEC_PROMPT.format(request=request, label=label_of(target), where="")
    answer, info = look(server, preset, [crop], text, SPEC_SCHEMA, max_tokens=200)
    return Change.model_validate(answer).block(), info

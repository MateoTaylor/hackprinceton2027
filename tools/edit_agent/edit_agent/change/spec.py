"""The `change` block of a target, and the VLM question that fills it from the request and the view.

  {"style": "recolor" | "restyle", "from": "blue", "to": "red", "keep": "grey piping", "form": "none" | "small"}

`style` recolor: only the colour changes, and the colour guardrail applies. restyle: the material,
finish or style changes, with no colour rule. `form` small: the outline may change a little (a more
modern lamp). `keep` names parts of the thing itself that stay as they are; never the room.
"""
import re
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


# The VLM misread two suite requests: "light oak with a strong grain" as a recolor from "dark wood",
# and "red tartan plaid" as a change of form. These words settle both.
MATERIAL = re.compile(r"\b(wood(en)?|oak|walnut|maple|pine|teak|mahogany|birch|bamboo|marble|granite|quartz|"
                      r"terrazzo|tiles?|subway|brick|stone|slate|concrete|leather|velvet|linen|wool|suede|rattan|"
                      r"wicker|metal|brass|copper|steel|chrome|glass|rubber|grain|veins?|veined)\b", re.I)
NEW_LOOK = re.compile(r"\b(modern|contemporary|rustic|vintage|traditional|minimalist|minimal|industrial|"
                      r"mid-century|farmhouse|retro|classic|fancier|simpler|sleeker|rounder|style|design|shape)\b", re.I)


def settle(block, request, target):
    """The VLM's change block with two fixed rules on top. Returns (block, the rules that changed it).
    - A material, pattern or picture word in what it becomes (`to`, or the request less the thing's own
      name) makes it a restyle: a recolor pastes only the old colour's pixels and keeps its pattern.
    - `form` is small only when the request asks for a new style, look or design."""
    from edit_agent.change.checks import BOLD, PICTURE
    name = f"{label_of(target)} {target.get('item') or ''}".lower()
    words = " ".join(w for w in re.findall(r"[\w-]+", request.lower()) if w not in name.split())
    out, rules = dict(block), []
    new = f"{block['to']} {words}"
    if block["style"] == "recolor" and any(r.search(new) for r in (MATERIAL, BOLD, PICTURE)):
        out["style"] = "restyle"
        rules.append("restyle: a material, pattern or picture is named")
    wanted = "small" if NEW_LOOK.search(request) else "none"
    if block["form"] != wanted:
        out["form"] = wanted
        rules.append(f"form {wanted}: the request {'asks' if wanted == 'small' else 'does not ask'} for a new look")
    return out, rules


def describe(server, preset, crop, request, target):
    """Fill the change block with one VLM question about a close-up of the thing, then `settle` it."""
    from edit_agent.steps import look
    text = SPEC_PROMPT.format(request=request, label=label_of(target), where="")
    answer, info = look(server, preset, [crop], text, SPEC_SCHEMA, max_tokens=200)
    block, rules = settle(Change.model_validate(answer).block(), request, target)
    if rules:
        info = {**info, "vlm_block": answer, "rules": rules}
    return block, info

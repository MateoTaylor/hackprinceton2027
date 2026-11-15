"""The image model's prompt for a change, built from the change block alone.

The VLM's own sentences (`instruction`, `behind`) never reach the image model: it obeys every word,
and a description of the wall or the light becomes an edit (Mateo-Agent's 14:50 note). Only the thing's
name and the change block's few words go in.
"""
import re

from edit_agent.change.colour import strip_colours
from edit_agent.change.spec import label_of

KEEP_LIGHT = " Keep the light on it exactly as it is: the same bright and dark sides, highlights and reflections."
GIVES_LIGHT = " It is switched on and glows as brightly as in the photo, with a light-coloured shade or glass that lets the light through."
LIGHTS = re.compile(r"\b(lamp|light|chandelier|sconce|pendant|lantern)s?\b", re.I)
KEEP_REST = " Keep everything else in the image exactly the same."


def prompt(target):
    c = target["change"]
    name = label_of(target)
    if c["style"] == "recolor":
        name = strip_colours(name) or name
        text = f"Change the colour of the {name} from {c['from']} to {c['to']}."
        if c["keep"]:
            text += f" Change only the {c['from']} parts. Leave the {c['keep']} unchanged."
        text += " Keep the pattern, texture and folds, the shape and the position."
    elif c["form"] == "small":
        text = (f"Replace the {name} with a {c['to']} {strip_colours(name) or name} of about the same size,"
                " standing in the same place.")
        if c["keep"]:
            text += f" Leave the {c['keep']} unchanged."
    else:
        text = f"Change the {name} from {c['from']} to {c['to']}. Keep its exact shape, edges and position."
        if c["keep"]:
            text += f" Leave the {c['keep']} unchanged."
        text += " Keep everything on it or in front of it exactly as it is."
    return text + KEEP_LIGHT + (GIVES_LIGHT if LIGHTS.search(name) else "") + KEEP_REST


def context_note(kind, name, to):
    """What a second picture is, for the panorama variants. The tags are the model's own (image1,
    image2): "the first image" made it return the second picture (qwen_test README, sofa_agent)."""
    head = " Make this edit to image1 only. The result is image1 seen from image1's own camera position."
    if kind == "chain":
        return head + (f" image2 is a different photo of the same room, taken from another position after this edit"
                       f" was made. Use image2 only to see what the {name} looks like now: give it the same {to}"
                       " colour, pattern and texture. Never copy the viewpoint of image2.")
    if kind == "guide":
        return head + (f" image2 is image1 with the new {name} roughly painted in from another photo; it has gaps and"
                       f" blurry parts. Use image2 as a guide to the {to} colour, pattern and texture and where they"
                       f" go on the {name}, and draw them cleanly.")
    return ""

"""Retexturing: a `change` request (a new colour, material or style for one thing). Owned by
Mateo-Retexture-Agent; see README.md here.

  python -m edit_agent.change one --input found.json            # one view
  python -m edit_agent.change pans --input found.json           # every panorama that sees the thing

A change is pasted inside the thing only, so the photo keeps its own shadows and glows. A recolour
also keeps the parts that are not the named colour. The image model's own change to the light next
to the thing is reported, not pasted.
"""

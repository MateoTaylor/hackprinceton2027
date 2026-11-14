# Retexture: the `change` edit

Owned by Mateo-Retexture-Agent. A change gives a thing in a scan a new colour, material or style:
"change the blue pillows to red", "make this countertop wood", "make this lamp more modern". It
starts from the finder's `found.json` (`edit_agent/find/`) and ends in an edited view plus a report
of issues for the second pass.

```
cd tools/edit_agent
PYTHONPATH=. .venv/Scripts/python.exe -m edit_agent.change one  --input <found.json> [--name N] [--change JSON]
PYTHONPATH=. .venv/Scripts/python.exe -m edit_agent.change pans --input <found.json> [--variants alone,chain,guide]
```

Runs go to `data/edit_agent/change/runs/<time>-<name>/` (git-ignored). `sheet.jpg` shows the photo,
the image model's picture, the pasted result, the mask, the colour mask and where the model changed
the light. `report.json` holds the numbers and issues. The cases are in `cases/retexture.json`.

## The change block

The target gets one more field. The VLM fills it from the request and a close-up (`spec.py`), or
`--change` gives it:

```json
{"style": "recolor", "from": "teal", "to": "red", "keep": "grey pattern and piping", "form": "none"}
```

- `style` is `recolor` (only the colour changes; the colour rule below applies) or `restyle` (the
  material, finish or style changes; no colour rule).
- `form` is `none` or `small` (the outline may change a little, as for "more modern").
- `keep` names parts of the thing itself that stay as they are. It never names the room.

`schemas.Target` drops unknown keys, so `__main__` adds `change` back after `steps.adopt`.

## The image model's prompt (`wording.py`)

The prompt is built only from the thing's name and the change block. The VLM's own sentences never
reach the image model, which obeys every word (see Mateo-Agent's 14:50 note in `notes/from-edit.md`).

Every prompt ends with "keep the light on it exactly as it is" and "keep everything else exactly the
same". For a lamp or another light, the prompt also says it stays switched on and glows as in the
photo.

## The paste (`paste.py`)

- **Where it pastes.** Inside the thing only, with no growth and no pasting of the model's shadow or
  glow. The photo's own shadows and glows stay (Mateo, 2026-11-14). With `form: small`, the area also
  includes SAM's outline of the new thing in the model's picture, kept inside the old box grown by 10%.
- **A recolour pastes only the named colour.** `colour.region` finds the thing's pixels near the
  named colour's hue in CIELAB (hue within about 25° to 45°, chroma above a quarter of the thing's
  median). The other colours on the thing stay the photo's. When the named colour is wrong ("blue"
  for teal pillows), the thing's most common hue is used.
- **Tone match.** The tone is matched with a Laplace membrane fitted just outside the paste.

## The checks (`checks.py`)

A removal's checks do not fit: its seam check measures the paste border, and here that border is the
thing's own edge, which changed on purpose.

| Issue | Measured by |
| --- | --- |
| `wrong_picture` | drift outside the paste > 40 |
| `not_applied` | mean change inside < 5; or for a recolour, the new hue more than 35° from `to`, or more than 15% of the old colour left in the paste; else the VLM says it is not `to`, or (recolour) still sees `from` on it |
| `shading_changed` | correlation of the thing's blurred lightness, photo vs result, < 0.55; else the VLM says it looks pasted on |
| `shadow_left` / `light_left` | the model relit more than 2% of the picture next to the thing (a warning: the photo's light is kept) |
| `form_changed` | the new outline's IoU with the old < 0.8, or more than 5% of it past the old box + 10% |

### The VLM question (`checks.question`)

The question is built from the change block and asks for `looks`, `is_new`, `natural` and, for a
recolour, `old_seen` ("is any part still teal, even thin lines?"). There is one close-up per
connected part of the paste, not one per finder box. Finder boxes overlap, and a box can hold a
pillow the recolour did not touch. The part is outlined in yellow, because a pillow in front of the
changed one otherwise becomes "the pillow in the middle". The crop is loose (margin 0.8): at 0.3 the
VLM missed a pillow left half teal.

It is tested on 12 labelled pictures of the pillows in panos 1 and 4: the photo, the strict paste, a
looser hue-only paste, the model's picture over the whole pillow, a half-applied paste, and one with
the grey pattern deliberately made red (`data/.../20261114-153620-pillows-pans/vlmtest/`):

- `old_seen` is right on every clear case. In pano 4 it also says "teal" on the strict paste, where
  the fabric's light swirls photograph grey-teal. That is fair: they do look teal there.
- **The VLM cannot judge `keep`.** Asked "does it still have its grey pattern?", it said no on
  nearly every red pillow. Asked for the pattern's colour, it echoed "grey" even where the pattern was
  made red. Without the colour word, it described the whole pillow. So `keep` is enforced by the
  colour mask and not asked about.
- **The VLM cannot choose the mask either.** All three candidate masks passed its check alike.
  Across panoramas the strict mask is also the most consistent (`same_parts` 0.64 against 0.61 for
  hue-only and 0.43 for the model's whole picture), because what stays the photo's is consistent by
  construction.

## Across panoramas (`views.py`, `pans`)

`pans` edits the found view, then lifts its mask onto the mesh (5 cm voxels) and finds every other
panorama that sees at least 30% of the thing. Each of those gets a framed view and a SAM mask
prompted from the mesh. Then it is edited three ways:

- `alone`: no context.
- `chain`: the first view's result is given as image2.
- `guide`: this view, with the first result drawn in through the mesh, is given as image2. This was
  the best context in the `qwen_test` benchmark.

`views.agreement` compares each result with the first one at surface points both views see:
- `same_parts`: of the points either view changed (by more than 12 CIELAB), the share both changed.
  A recolour changes only part of the thing, so this asks whether both views recoloured the same
  parts.
- `change_gap`: the median CIELAB distance between the two views' changes (result minus photo), over
  those changed points. It is lower when the new colour matches. `colour_gap_photo` is the photos' own
  gap there, for scale.
- `pattern`: the correlation of light and dark detail (2 to 8 px) between the two results.
  `pattern_photo` is the same between the two photos, and is the ceiling for that pair. At 1 to 4 px
  the ceiling was only 0.2, because the mesh lines the views up to within a few pixels.

Two traps found on the way. The median change over all of the thing's points was 0: a recolour leaves
most of a patterned pillow alone. And with context pictures, Qwen-Image-2.1 wants every input at a
multiple of 32 px, so `generate` fits the 720 px view to 736.

## Results so far (720 px, scan zzvymDx5ty7)

Each `one` run takes about 26 s on the GPU.

- **Pillows, recolour teal to red.** Both teal pillows turn red, and their grey pattern and piping
  stay grey. The grey chevron pillows, the sofa and the painting stay. hue_off 1.7°, old colour left
  0%, shading 0.92, fine detail 0.73. The VLM says "red velvet with grey pattern" for both. No issues
  at 16:08. A re-run at 16:20 got the same scores, but the VLM called the left pillow not natural
  (`shading_changed`). The image model is not bit-exact on the GPU even with a fixed seed, and that
  close-up is borderline: its red is flatter than the photo's light. So one run's VLM answer is not a
  verdict.
- **Countertop, granite to wood.** The image model kept the sink, the faucet and both woven balls
  on its own. Shading 0.75, drift 9.9, VLM "light brown wood". No issues. The 2% effect limit is
  what stops a false `light_left` on the redrawn balls.
- **Lamp, "more modern".** This is the reach case and still fails. The image model draws an opaque
  black drum shade and paints new light cones on the wall, even when told the shade lets the light
  through. The checks catch it: `shading_changed` (0.14), `shadow_left` (7% relit) and
  `form_changed` (IoU 0.54).

### Across panoramas: does conditioning keep the texture?

Each other panorama is edited three ways (alone, chain, guide). Runs:
`20261114-153620-pillows-pans` and `20261114-154353-counter-pans`.

| Case, pano | change_gap alone / chain / guide | pattern alone / chain / guide (photo ceiling) |
| --- | --- | --- |
| Pillows, pano 4 | 27.5 / 26.9 / 26.2 | 0.36 / 0.37 / 0.36 (0.35) |
| Pillows, pano 7 | 21.4 / 23.4 / 22.2 | 0.07 / 0.06 / 0.10 (0.18) |
| Pillows, pano 5 | 29.7 / 28.2 / 33.9 | 0.26 / 0.28 / 0.26 (0.26) |
| Countertop, pano 7 | 13.2 / 18.0 / 17.1 | 0.45 / 0.18 / 0.26 (0.22) |
| Countertop, pano 5 | 9.4 / 12.0 / 15.0 | 0.18 / 0.17 / 0.17 (0.25) |
| Countertop, pano 1 | 10.8 / 10.7 / 11.4 | 0.24 / 0.43 / 0.60 (0.34) |

- **A recolour does not need conditioning.** The colour mask keeps the photo's own pattern, and the
  photos agree with each other.
- **"Wood" did not need it either.** `alone` is already as consistent as the photos: the wood's
  colour gap between views (10.5, 7.6, 6.5) is close to the photos' own (7.2, 6.8, 7.6). The image
  model draws much the same generic wood every time. Chain and guide darken it a little. The guide
  helped grain alignment once (pano 1); its mesh-warped input from far views is patchy.
- **Open question.** Generic materials are consistent anyway. A distinctive, invented pattern (bold
  marble veins, a plaid) is where views would disagree and conditioning could help. That case is
  not tested yet.
- **Known false alarm.** `shading_changed` fires on thin, distant countertops: at that size the
  blur meant for "the light on it" keeps the wood grain.

## Not done

- **Floors and walls by words.** Mateo put these after small items and furniture.
- **A plural spread across several views.** `pans` follows one lifted mask, so things that need
  separate vision runs are not merged yet.
- **The call sites in the edit graph.** These are Mateo-Agent's files; the requests are in
  `notes/from-input.md`.

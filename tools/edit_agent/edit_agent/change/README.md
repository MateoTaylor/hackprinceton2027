# Retexture: the `change` edit

Owned by Mateo-Retexture-Agent. A change gives a thing in a scan a new colour, material or style:
"change the blue pillows to red", "make this countertop wood", "make this lamp more modern". It
starts from the finder's `found.json` (`edit_agent/find/`) and ends in an edited view plus a report
of issues for the second pass.

```
cd tools/edit_agent
PYTHONPATH=. .venv/Scripts/python.exe -m edit_agent.change one  --input <found.json> [--name N] [--change JSON]
PYTHONPATH=. .venv/Scripts/python.exe -m edit_agent.change pans --input <found.json> [--variants alone,chain,guide]
PYTHONPATH=. .venv/Scripts/python.exe -m edit_agent.change.suite [--only a,b] [--group g] [--pans] [--list]
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

Two fixed rules settle the VLM's answer (`spec.settle`; its own answer stays in the info as
`vlm_block`). A material, pattern or picture word in `to` or in the request (less the thing's own
name) makes it a `restyle`, because a recolour pastes only the old colour's pixels and keeps their
pattern. `form` is `small` only when the request asks for a new style, look or design ("modern",
"rustic", "simpler"). On the 35 stored suite answers the rules changed five, all for the better: the
VLM had called gingham, stripes and two oak requests a recolour, and "red tartan plaid" a change of
form. The 20 plain colour requests stay recolours.

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
| `not_applied` | mean change inside < 5; or for a recolour, the new hue more than 35° from `to`, or more than 15% of the old colour left in the paste; else the VLM says it is not `to`, or (recolour) still sees `from` on it. Also (recolour): the old colour goes on past the thing's outline, connected to it, over more than 2.5% of the pasted area (`old_outside`): the finder's mask missed part of the thing |
| `shading_changed` | correlation of the thing's blurred lightness, photo vs result, < 0.55. For a recolour from a colour with a hue, the blur averages only the recoloured pixels. Not raised for a restyle to a new painting or print or to a bold pattern (zebra, plaid, leopard): the blur keeps the stripes, so it would compare two patterns, not the light (`new_picture`). The VLM saying it looks pasted on is a note only (severity 1) |
| `shadow_left` / `light_left` | the model relit more than 2% of the picture next to the thing. A note only (severity 1): the photo's light is kept |
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
panorama that sees at least 30% of the thing and stands at least 0.8 m from it (`--min-distance`).
From 0.26 m the door was a bare slab, with neither its panels nor its grain. Every other view is
measured against the first one, so a first view with a severity-3 issue is generated again with up
to two new seeds (`--retries`), and the least bad result is kept (`attempts` in its report.json). Each of those gets a framed view and an outline: the
mesh's own (the pixels whose first mesh hit is the thing), sharpened by SAM when SAM agrees with it.
SAM is asked twice, with the box and points from the mesh and with the box alone, and its best
outline is kept if it overlaps the mesh's by 0.6 (`MIN_SAM_IOU`). Below that the mesh's outline is
used. The log says which (`mask from pts / box / mesh`). The outline is then tidied
(`views.tidy`): gaps up to 3 px are closed and enclosed holes up to 2% of it filled, but never
where the mesh sees something 30 cm or more from the thing or where the first view left something
out. Past the mesh's outline, only SAM's solid parts stay, and a separate piece that does not come
within 1.5% of the view of the mesh's outline is dropped (`PIECE_REACH`): on the bath print a patch of
wall near the ceiling became a second close-up, which the VLM rightly said was no flower painting. On the oak cabinets, SAM's holes and
dots left dark speckles of the old wood in the result; re-pasted offline with the tidied outline,
they are gone except where the cabinet runs past what the first view saw. A wider close (8 px) was
tried and dropped: the mesh's outline of a painting takes in about 5 cm of wall, and SAM's dotted
halo there became solid wall.

Without a mesh the other panoramas cannot be found or outlined, so `pans` edits only the found view
and says why in pans.json (`single_view`). Each other view is edited one of these ways:

- `alone`: no context.
- `chain`: the first view's result is given as image2.
- `guide`: this view, with the first result drawn in through the mesh, is given as image2. This was
  the best context in the `qwen_test` benchmark.
- `auto`, the default (Mateo, 2026-11-14): `guide`, or `alone` where the guide fills less than half of
  the thing (`MIN_GUIDE_FILL`), because there it is mostly the old photo. In the multi-view suite
  the guide filled 77% to 100% of most things; the two countertops (44% to 64%) were the ones whose
  guide was smeared. `--variants alone,chain,guide` still runs all three to compare them.

`views.agreement` compares each result with the first one at surface points both views see:
- `same_parts`: of the points either view changed (by more than 12 CIELAB), the share both changed.
  A recolour changes only part of the thing, so this asks whether both views recoloured the same
  parts.
- `change_gap`: the median CIELAB distance between the two views' changes (result minus photo), over
  those changed points. It is lower when the new colour matches. `colour_gap_photo` is the photos' own
  gap there, for scale.
- `pattern`: the correlation of light and dark detail (2 to 8 px) between the two results, over the
  changed points. `pattern_photo` is the same between the two photos, and is the ceiling for that
  pair. At 1 to 4 px the ceiling was only 0.2, because the mesh lines the views up to within a few
  pixels. Until 20:20 on 2026-11-14 it was taken over all the points, kept parts too. Recomputed on
  four stored multi-view cases (painting, print, door, armchair), the change moves it by 0.04 at most:
  78% to 100% of the shared points changed, so kept parts weighed little.

Five traps found on the way.
- The median change over all of the thing's points was 0: a recolour leaves most of a patterned
  pillow alone.
- With context pictures, Qwen-Image-2.1 wants every input at a multiple of 32 px, so `generate` fits
  the 720 px view to 736.
- SAM prompted with the box and many mesh points often outlined the wall around the thing in a
  dotted pattern. Its overlap with the mesh's outline was 0.2 to 0.69 in all nine views of the first
  runs. On the painting, the edit then stayed on the old painting and a cyan halo was pasted onto the
  wall, and the guide was mostly the old painting. The fallback above fixes this. Runs before 17:21
  on 2026-11-14 (including the pillow and countertop table below) used the bad outlines in far views.

- The tone match undid a dark change. A dark walnut door made the image model darken the hall
  around it too; the tone match carried that difference into the door (+135 levels) and pasted a
  grey door, three seeds in a row, while the model's own picture was walnut. The same happened to
  `front-door-navy` (+131). The tone match is now held within 15 levels of its median over the
  picture (`paste.TONE_BAND`); every other suite case had a shift under 19, and painting-new and
  countertop-wood change by under 4 levels.
- The thing's voxels take in what leans on it. On `sofa-plaid` the first view's mask left the
  pillows out, but its 5 cm voxels include them, so in pano 7 the outline took in the pillows and
  they were repainted plaid. What the first mask left out near the thing is now lifted too
  (`views.lift_keep`: mesh hits in the mask's box grown by 15%, minus the mask grown by 4 px, minus
  the thing's voxels) and cut from every other view's outline (`keep_cut` in the log). Checked
  offline on that run's three other views: the pillows are cut in panos 4 and 7. Runs before
  18:50 on 2026-11-14 do not have this.

The guide casts one ray per 2 px and gives each pixel its block's position in the first view, moved by
its offset. At one ray per pixel it took 2 to 3 minutes a view; now it takes about 25 s. The
correspondences for `agreement` are cast once per view and shared by its three variants.

## The suite (`suite.py`, `cases/retexture.json`)

```
PYTHONPATH=. .venv/Scripts/python.exe -m edit_agent.change.suite --pans-only --max-views 4   # the multi-view suite
PYTHONPATH=. .venv/Scripts/python.exe -m edit_agent.change.suite --only door-walnut,rug-zebra  # in this order
PYTHONPATH=. .venv/Scripts/python.exe -m edit_agent.change.suite --single                      # every case, one view
```

53 cases on the two downloaded scans: the apartment (`zzvymDx5ty7`, with a mesh) and the exterior
(`2rPahZzW6H7`, no mesh, so one view only). Each case has a finder command (a click on the 0-1000
scale, or words and a view for a plural), the request and what a good result looks like.

The main test is one thing seen from several panoramas (Mateo, 2026-11-14). 23 cases are marked
`pans`: the found view is edited, then up to three other panoramas that see the thing, each `alone`,
`chain` and `guide`. Each gets a **consistency sheet** (`consistency.jpg` in its run folder): a row per
panorama, cropped to the thing, with the photo, the first view's result moved into that view through
the mesh (what this view should show), and each variant's result, captioned with `change_gap` and
`pattern` against the photos' own. The texture cases come first: two new paintings and a new print,
walnut door, oak cabinets, wood and marble countertops, zebra rug, tartan sofa, leopard armchair.

| group | cases | multi-view | what it tests |
| --- | --- | --- | --- |
| texture | 5 | 5 | a new picture or a strong grain: a painting, a print, a walnut door, oak cabinets |
| pattern | 6 | 6 | a bold invented pattern (marble veins, tartan, zebra, gingham, stripes, leopard) |
| restyle | 13 | 5 | a new material or finish: wood countertop, leather sofa, oak dresser, subway tile |
| recolor | 16 | 6 | one colour to another; the photo's own pattern stays, so views agree by construction |
| neutral | 9 | 1 | from or to white, grey, beige, black or gold, where hue says little |
| form | 4 | 0 | "more modern": the outline may change a little |

The finder runs once per case and is cached in `data/edit_agent/change/suite/found/`. A run writes
`summary.json`, `summary.md` (with a per-variant agreement table for the multi-view cases) and
overview pages of the found views to `data/edit_agent/change/suite/<time>-<label>/`.

Each case can carry a `verdict`: a person's judgement after looking at the sheet, starting with
`good` or `bad`. The suite compares it with the checks: a good result with no issue of severity 2 or
more is a true pass, a bad one with an issue is caught, and the other two are a false alarm and a
miss. So the suite measures the checks as well as the edits.

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
- **Generic materials are consistent anyway.** A distinctive, invented pattern is where views
  disagree; the multi-view suite below tests it.

### The multi-view suite (run `20261114-174703-multiview4`)

12 texture and pattern cases, each edited in the found view and in up to three other panoramas, each
`alone`, `chain` and `guide`. The verdicts are in `cases/retexture.json`. Every first view is good.

- **Plain materials hold across views in every variant**: walnut door, wood countertop, oak
  dresser, subway tile (`change_gap` 5 to 22, about the photos' own 10 to 18).
- **A random print holds as a print, not as a layout.** The leopard armchair is the same tan ground
  and spot size in all nine results, with the lilac pillow kept, but the spots do not line up. Zebra
  stripes and marble veins keep the style but not the layout (pattern about 0.1 against the photos'
  0.3 to 0.6), and 8 of 9 zebra results added a red border the first view did not have.
- **A new picture needs context.** On the bath print, `chain` drew the same bouquet and rainbow frame
  in both other views; `guide` drifted back to the photo's black frame; `alone` drew other paintings.
  On the bed painting, `guide` kept the first view's ridge best in pano 1.
- **The guide wins where the first view saw the thing well** (gingham runner: closest blue and check
  size), and smears where it saw it at a grazing angle (marble countertop). This is why `auto`
  falls back to `alone` below half a fill.
- **A thing larger than the first view is only partly changed elsewhere.** The backsplash and the
  gingham runner change in other views only over the stretch the first view saw, leaving a hard
  seam to the old tiles or the old yellow (Mateo's problem 1). The oak cabinets have the same limit:
  the found mask is the upper run only.

The live re-run of `sofa-plaid` at 20:09 (`20261114-200948-suite-sofa-plaid`), with keep-out,
`tidy`, `auto` and `settle`: `form` is now `none`, `auto` chose `guide` in all three views (fills
96%, 84% and above), the pillows stay in every view including pano 7 (`keep_cut` 11.7% there), and
all three are the same red tartan with no issue above severity 1.

**What the checks get wrong across views:**
- `not_applied` 3 on the bath print's panos 0 and 7: a stray piece of outline (see `tidy` above).
  Fixed; checked offline on the stored outlines (2 parts to 1 in both).
- `not_applied` 3 on the wood countertop's pano 7 `alone`: SAM's box outline takes in the island's
  white side panel under the top, and the VLM judges that. Open.
- `shading_changed` 2 on most `chain` and `guide` countertop views (shading down to -0.16) is real:
  image2 carries the first view's light into this one. A tone fix is deferred (Mateo, 2026-11-14).

## Not done

- **Floors and walls by words.** Mateo put these after small items and furniture.
- **A plural spread across several views.** `pans` follows one lifted mask, so things that need
  separate vision runs are not merged yet.
- **The call sites in the edit graph.** These are Mateo-Agent's files; the requests are in
  `notes/from-input.md`.
- **Things larger than one view** (backsplash, floor, a long runner): several views would need to be
  edited and stitched. Mateo's problem 1.
- **The light under `chain` and `guide`**: the context picture's light leaks in (see above).
- **A second change pass for a leftover strip** (the runner's far end): not approved; not built.

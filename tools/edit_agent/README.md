# Scan edit agent

A typed request such as "remove the table lamp" changes one view of a scanned room and reports what
is still wrong with the result. It is a LangGraph graph in Python over the local models in
[`tools/qwen_test/`](../qwen_test/README.md): Qwen3-VL-8B finds the thing, SAM 2.1 outlines it and
Qwen-Image-2.1 redraws the view. Everything runs on the PC that hosts those models. No picture
leaves it.

**Built so far: the first pass on one view, for a removal and for a change, and three repairs.** It
removes an object, or the clutter on one, or changes a surface (a new countertop, floor or pillow
colour), and lists glaring problems. It repairs three kinds by itself: an edit that failed outright
is drawn again with a new seed, a neighbour that went with the object (a baseboard, a vent) is put
back, and a thing left behind (a vase left floating) is removed again. See
[The second pass](#the-second-pass) and [Removal and retexture in one graph](#removal-and-retexture-in-one-graph).
A second graph carries the edit to every panorama that sees the thing, through the scan mesh. See
[Every panorama that sees the thing](#every-panorama-that-sees-the-thing).
Other repairs, adding objects, skills and a Deep Agents coordinator are not built. See
[Not built, not verified](#not-built-not-verified).

## The first pass

```
prepare -> locate -> segment -> [describe] -> generate -> paste -> measure -> inspect -> report
                                                            ^                               |
                                                            +---------- repair <------------+  at most once
```

| Step | What it does | With |
| --- | --- | --- |
| prepare | Writes the working image: a picture you give, or a view rendered from a downloaded scan | Pillow |
| locate | Finds every object the request applies to (boxes), and writes the instruction for the image model. For a removal, a second look on a close-up lists each separate thing it takes (see [Locating clutter](#locating-clutter)) | Qwen3-VL |
| segment | Outlines the object inside each box | SAM 2.1 |
| describe | A change only: what the thing is made of now and what it becomes, from a close-up (see [Removal and retexture in one graph](#removal-and-retexture-in-one-graph)) | Qwen3-VL |
| generate | Redraws the whole view from the instruction | Qwen-Image |
| paste | Puts the area around the object, plus its shadow however far it runs, back into the original, with tones matched at the border (see [Shadows](#shadows-and-the-difference-map)) | numpy |
| measure | Numbers: change outside the area, change inside it, the tone step at its border, tone shift, and how much of the object's shadow the paste missed. Also marks places where the edit removed or added edges outside the object (the scout) | numpy |
| inspect | Four short questions about the result (see [The check](#the-check)), and two or three per marked place, within 5 s | Qwen3-VL |
| report | Writes `report.json` and `sheet.jpg` | Pillow |
| repair | Only if an issue carries an `action`: draws the edit again with a new seed, puts a lost neighbour back, or removes a leftover again, then measure, inspect and report run again (see [The second pass](#the-second-pass)) | Qwen-Image, numpy, or SAM and Qwen-Image for a leftover |

If the thing is not in the picture, the graph goes from locate straight to report with a
`not_found` issue (about 5 s). The models take turns on the GPU, because they do not fit in 16 GB
together.

## Set up

`tools/qwen_test/` must be set up first (model files, runner programs, `.venv-sam`). Then, with
Python 3.12, from the repo root:

```
py -3.12 -m venv tools/edit_agent/.venv
tools/edit_agent/.venv/Scripts/python -m pip install -r tools/edit_agent/requirements.txt
```

## Run from the command line

From `tools/edit_agent/`:

```
.venv\Scripts\python -m edit_agent.run --image ..\qwen_test\cases\lamp_table\p1\target.png --request "remove the table lamp and the small gold side table it stands on" --preset fast
```

It prints each step with its seconds, then the report and the run folder. `--scan MODEL --pano N
--yaw DEG [--pitch DEG] [--fov DEG]` renders a square view from a downloaded scan instead of
`--image`.

## Run as a server

From `tools/edit_agent/` (graph paths in `langgraph.json` are read from the current folder):

```
set LANGGRAPH_CLI_NO_ANALYTICS=1
.venv\Scripts\langgraph dev --port 2025 --no-browser --no-reload
```

This is a local LangGraph Agent Server on `127.0.0.1:2025` with three graphs: `first_pass` (one
view), `all_views` (every panorama that sees the thing) and `find_target` (the finder,
Mateo-Retexture-Agent's). Tracing is
off (`LANGSMITH_TRACING=false` in `langgraph.json`). `--no-browser` matters: the Studio page it
would open is hosted on smith.langchain.com. Runs are kept in memory only.

A client streams a run with the LangGraph SDK (`@langchain/langgraph-sdk` or `useStream` in
JavaScript). In Python:

```python
from langgraph_sdk import get_sync_client

client = get_sync_client(url="http://127.0.0.1:2025")
for part in client.runs.stream(None, "first_pass", stream_mode=["custom", "values"], input={
        "image": r"C:\full\path\to\view.png", "request": "remove the table lamp", "preset": "fast"}):
    print(part.event, part.data)
```

- `custom` events are progress: `{"step": "generate", "status": "started"}` and then
  `{"step": "generate", "status": "done", "seconds": 21.3, ...}`.
- `values` events are the state so far. The last one holds the result.

### Input

| Field | Meaning |
| --- | --- |
| `request` | What to change, in plain words. Required |
| `image` | Path to a picture on this PC. Give this or `scan` |
| `scan` | `{"model": id, "pano": index, "yaw": deg, "pitch": deg, "fov": deg}` for a downloaded scan |
| `preset` | `720` (default), `quality`, `fast` or `draft` |
| `name` | Label for the run folder |
| `target` | A thing that was already found. Skips locate. See [Handing in a target](#handing-in-a-target) |
| `mask` | With `target`: path to a mask image, white = the item. Skips segment |
| `raw` | With `target` and `mask`: path to a picture the image model made earlier. Skips generate, so a finished run can be replayed from its paste in about 13 s |

### Result

| Field | Meaning |
| --- | --- |
| `paste_mask` | Path to every area pasted over the original view, across all passes (white = changed). Also in `report.json` |
| `edited` | Path to the edited picture. After a restore it is `edited_2.png`; after a second removal it is `pass2/edited.png`. The first pass's `edited.png`, `report_1.json` and `sheet_1.jpg` stay in the run folder |
| `regions`, `repairs` | The places the scout marked, and what the repair did |
| `report` | `{verdict, issues, notes, scores, summary}`. `verdict` is `pass` or `fix` |
| `sheet` | Path to one picture of the run: before with boxes, mask with shadow and paste area, after with the issues marked, and a map of what changed |
| `run_dir` | The run folder, `data/edit_agent/runs/<time>-<name>/` (git-ignored) |
| `target`, `findings`, `timings` | What the locator found, the VLM's answers, seconds per step |

Each issue is `{kind, severity, source, evidence, region, repair, action, what}`. `severity` is 3
when the edit failed, 2 when a problem is clear at a glance, 1 when it is faint. Faint findings go to
`notes`, not `issues`. `region` is `[x0, y0, x1, y1]` in pixels of the working image. `repair` says
in words what a second pass would do. `action` is set only when the graph can do it by itself:
`regenerate` (draw again with a new seed), `restore` or `remove_again`, and for `remove_again`, `what`
names the thing to remove. After a repair, `timings` has keys such as `measure_2`.

| Kind | Found by |
| --- | --- |
| `not_found` | The locator, or an empty SAM mask |
| `object_remains` | The VLM still sees the thing in a close-up, sees something floating there, or names it at a scouted place; or almost nothing changed inside the mask |
| `object_added` | The image model drew something new. With "remove everything on the dresser", a thing on the dresser in the result that was not on it before (severity 3, `remove_again`, taken only inside the paste area); a scouted place that showed surface and now shows an object (a note) |
| `not_applied` | A change that did not land: almost nothing changed, the new colour is far from the one asked, or the VLM does not see the new look (`change/checks.py`) |
| `shading_changed`, `form_changed` | A change only: the light on the thing no longer follows the photo's, or its outline moved (`change/checks.py`) |
| `shadow_left`, `light_left` | The VLM, in a close-up of the edited area. Also numbers: the image model cleaned an area up and the paste kept the original there |
| `color_mismatch` | The VLM, in a close-up of the edited area |
| `damaged_neighbour` | The scout marks a place and the VLM names what is in it, before and after (see [The second pass](#the-second-pass)). Also the VLM comparing the whole pictures, which has never fired |
| `visible_seam` | The tone step right at the border of the pasted area, along the worst tenth of it (see [The seam check](#the-seam-check)) |
| `wrong_picture` | Change outside the pasted area: the model drew a different room |

## Presets

Resolution is a setting. Measured on the lamp view, one RTX 5070 Ti, including model loading:

| Preset | Image | Steps | Generate | Whole pass | Result |
| --- | --- | --- | --- | --- | --- |
| `quality` | 1024 px | 20 | 48 s | 80 s | Clean |
| `fast` | 768 px | 20 | 21-23 s | 45-46 s | Clean, with a faint arc of lamp glow left on the wall |
| `720` | 720 px | 20 | 19 s | 38-41 s | Clean on the four test views (measured on those, not on the lamp view) |
| `draft` | 512 px | 12 | 8 s | 26 s | For testing the steps, not for results |

`720` is the default (`DEFAULT_PRESET` in `config.py`): it takes half the time of `quality`. The
finder in `edit_agent/find/` reads the same default.

Presets and the limits of the checks are in `edit_agent/config.py`. Nothing else is stored: no
memory between runs.

## Shadows and the difference map

The image model gets the instruction and the whole view. It gets no mask, and it redraws the whole
picture. The mask only decides which part of that picture is pasted back.

A long shadow used to survive as a stub. The image model had removed it, but the paste copies only
an area around the object (the mask grown by 100 %, the same in every direction), and a low sun
throws a shadow far in one direction. The far end came back from the original.

Now the paste compares the image model's picture with the view:

1. Blur the brightness difference, going around the object. The model redraws every texture, so
   single pixels differ everywhere. A shadow or a glow is a smooth change and survives the blur.
2. Keep the pixels where the change is clear (four times the picture's own drift, and at least 10
   of 255).
3. Grow outwards from the object through those pixels. This follows a shadow to its end and leaves
   out changes elsewhere in the picture.

That region is the object's **effect**: its shadow, reflection or glow. It is saved as `effect.png`
and added to the pasted area. The search runs on a 256 px copy and takes 0.3 s. If the region
covers more than a quarter of the picture, the model relit the scene and the region is ignored.
`Preset.follow_change = False` turns this off.

The instruction for a removal also names the shadow ("Remove the shadow it casts and its reflection
too"). Without that sentence the image model removed the bins in one street view and left the far
end of their shadow.

Scores: `effect_share` (share of the picture), `effect_sign` (above 0: the model made the area
brighter, so a shadow went), `paste_added`, and `effect_left` (effect outside the pasted area).
`effect_left` above 0.1 % of the picture raises `shadow_left` or `light_left`. With `follow_change`
on it is 0 unless the region was ignored. Run on the pastes made before this change, it flagged the
two street views that had a visible stub.

The fourth panel of `sheet.jpg` is the plain map: |before - after| per pixel, times 4, colour-mapped.
It is also saved as `diff.png`.

**What this cannot see.** A shadow the image model left in shows as no change, so the map is black
there. Only the VLM's question can catch it, and the VLM does not see shadows on a street: on three
pictures with a clear leftover shadow it answered "none" in 5 of 6 tries.

## Test cases

`cases/removal.json` holds the removal cases: two interior (an armchair, and a lit table lamp whose
glow covers the wall) and one exterior (two bins at the curb, from three panoramas). It names scans and views, not pictures. Only the request
and the view are chosen by hand. From `tools/edit_agent/`:

```
.venv\Scripts\python -m edit_agent.suite
```

It runs every view through the graph and prints a table. Measured at 720 px, with the scout and its
questions: 39 to 43 s per view when the GPU is free, 200 s for the five. All five pass, and no
repair is triggered: with the current instruction the image model keeps the baseboard. The tone
step at the paste border measures 3.6 to 7.6 against a limit of 12 (see
[The seam check](#the-seam-check)). The armchair passes with a paler patch of floor where it stood.

The scout marks one to three places in each view. On the street it marks the bins' shadow, and the
VLM names it shadow before and surface after in all three views, so nothing is reported.

### Cases seen from several panoramas

`cases/multiview.json` holds four more removal cases, each seen from two or three panoramas: a
coffee table with a tray and a vase on it, a dresser with a lamp and vases on it, and on the
exterior scan a window and the garage door. The exterior cases edit the house itself and are odd on
purpose. Each view is edited on its own, so nothing makes the views agree.

```
.venv\Scripts\python -m edit_agent.suite cases\multiview.json
.venv\Scripts\python -m edit_agent.stages --suite <the table the first command names>
```

The second command draws one PNG per case in `data/edit_agent/outputs/stages/` (git-ignored). A
row is a panorama and a column is a stage: the view, the VLM's boxes, the mask, the image model's
redraw, the pasted first pass, what the check flagged, and the second pass. It reads the run
folders and runs no model. It also takes run folders by name, one row each.

Measured at 720 px on 2026-11-14: nine views in 468 s, with the retexture suite sharing the GPU.

| Case | Panorama | What the first pass did | What the check said |
| --- | --- | --- | --- |
| Coffee table | 1 | Table and tray gone. The vase is left floating. | Pass, which is wrong. |
| | 4 | Everything gone, the rug is clean. | `object_remains`, a false alarm: in its close-up the VLM took a side table at the edge for the coffee table. |
| | 7 | Table and tray gone. The vase is left floating. | `color_mismatch`. The scout marked the vase, but the VLM named it an object before and after, so it is not reported. |
| Dresser | 6 | Dresser, lamp and vases gone. The wall hanging above it is gone too. | `visible_seam` at 12.05 against 12, a false alarm: 97% of the picture is pasted and no border shows. |
| | 2 | Dresser and vases gone. The lamp is left floating, and the redraw left a grey patch at the top of the wall. | `visible_seam` at 25.9, which is the grey patch. The lamp is not reported. |
| Window | 3 and 4 | Window gone, the wall closes up. The plants, house numbers and sign stay. | Pass in both, which is right. |
| Garage door | 1 and 7 | The door becomes a plain brown panel in its recess, the same brown in both views. | Pass in both, which is right. |

- **A thing is removed only when the instruction names it.** In the three views where the VLM gave
  one box and wrote "everything on it" or named only some of the things, something that stood on
  the furniture is left floating. In the two views where it gave a box and a name for each thing,
  all of them went, in one case with a wall hanging that should have stayed.
- **The check does not see a floating thing.** The VLM's close-up answered that nothing is still
  visible in all three views.
- **No second pass ran.** Four views were reported, none with an issue that has a repair.

### Light sources

`cases/lights.json` holds six harder cases, each from two or three panoramas: a lit bedside lamp,
a lit lamp on the dresser, a ceiling fan with its light, a track light whose spots draw glare
streaks across the ceiling, the bedroom window (the room's daylight), and on the exterior scan the
rainbow lens flares from the sun. Run it and draw it as above, with `cases\lights.json`.

Measured at 720 px on 2026-11-14: sixteen views in 1030 s, with the retexture suite sharing the GPU.
Fifteen pass and one is reported. Looked at full size, fourteen are clean and two are not:

| Case | Panoramas | What the first pass did | What the check said |
| --- | --- | --- | --- |
| Bedside lamp | 6, 2, 1 | Lamp, its glow on the wall and its reflection on the nightstand gone. The blue vase beside it stays. | Pass in all three, which is right. |
| Dresser lamp | 6, 2 | Lamp and its glow gone. The vases and the wall hanging stay. | Pass in both, which is right. |
| Ceiling fan | 6, 8 | Fan, lit bowl, chains and blade shadows gone. | Pass, which is right. |
| | 2 | The same, but the air vent beside the fan is gone too. | Pass, which is wrong: a blade covers the vent, so the vent lies in the ring around the item that the scout leaves out. |
| Track light | 0, 7, 5 | Track, spots and their glare streaks gone. The recessed lights, smoke detector and vent stay. In 7 a small hook below the track went too. | Pass in all three, which is right. |
| Bedroom window | 6, 2, 8 | Window, blinds, curtains and rod gone. The wall closes up and the room stays as bright. In 2 the whole picture is redrawn, so the tray and pillows come back a little softer. | 6: `visible_seam` at 18.1, a false alarm: 98% of the picture is pasted. 2 and 8: pass. |
| Lens flare | 4 | Every flare gone, the plants under it redrawn and plausible. | Pass, which is right. |
| | 7 | Both flares gone. The tree's shadow and the sun spots on the driveway went too, and its crack moved. | Pass, which is wrong. The scout marked the driveway, but surface before and after is not reported. |

- **Removing a light works.** The glow on the wall, a reflection on the furniture and glare
  streaks all go with the light, in every view, and the views agree.
- **The seam alarm is wrong when nearly all of the picture is pasted.** Both alarms above 97%
  pasted (here and the dresser) are false.
- **The effect region takes whatever light the image model changed next to the item.** For a lamp
  that is its glow. For the flare it took real shadows too. Where a glow or flare went, the region
  mostly got darker (the lamps, track 0 and 5, flare 4), and the driveway got brighter where its
  shadow went. Track 7 got brighter too and looks right, so the direction alone does not yet tell
  the two apart.

## Locating clutter

A thing that stood on a removed table and was not boxed stays outside the cut-out and is left
floating. The 8B VLM often gave one box for a table and everything on it, or left out the vases or
the tray: 5 of 13 stored views. Three changes in `steps.locate`:

- **The wording** asks for one entry per object, a separate entry for each thing resting on a
  removed one, and none for a picture or mirror on the wall above (that was removed in one dresser
  view).
- **A second look** (`steps.things`, one question, about 1 s): on a close-up of what was found,
  "list each separate thing this removal takes". Boxes that repeat one already found are dropped. It
  added the missing things in 4 of the 5 views and nothing wrong in the lamp views.
- **Only what was asked** (`steps.asked`, no model): when the request names things ("the tray and
  the throw pillows"), boxes for a noun it does not name are dropped, unless they lie on a kept one.
  The VLM boxed the throw blanket in 2 of 3 bed views, and the blanket went. Nothing is dropped for
  "everything on ..." or when no box matches the request's words, because names can differ in
  wording only. On the 38 distinct removals stored so far it dropped only those two blankets.
- **Only what stands on the place** (`steps.belong`, one question per box, about 0.5 s each): for
  "everything on" a place, each box the request does not name is asked about on the whole picture,
  boxed in red: what is the surface under it (`BELONG_PROMPT`)? It stays only if that surface is the
  place ("top of dark wooden dresser"), or a thing already kept ("teal tray" under a vase). For "the
  dresser and everything on it" the VLM boxed the tray on the bed beside it; asked what is under the
  tray, it says "bed". The VLM's own yes or no in the same answer is not used: it wrote under "bed"
  and "on the dresser" together, and one changed word in the prompt flipped it. What it names as the
  surface was right in 27 of 27 answers (18 things on dressers and coffee tables, plus 9 second-pass
  boxes below).

Both filters run after the second look, so what it adds is filtered too. The request's place is
read without a model (`schemas.read_request`): "remove the tray and the throw pillows from the bed"
names a tray and throw pillows, on the bed. Only a place after "on" ("from", "off") is asked about as
a surface; "at the curb" or "in the cabinet" is not.

The locator can still miss a thing the request names: in the 20:00 suite ("remove the tray and the
throw pillows from the bed", three views) one view kept the tray and one kept the throw pillows, and
all three passed, because the check asked only about what the locator named. The check now asks
about the request's own words too (question 5 below).

## The check

The check is loose on purpose. It exists to catch what a first pass plainly got wrong, so that a
second pass has a short list. It asks the VLM five questions with fixed answers:

1. Before and after, side by side: was the change applied, and was a neighbour damaged?
2. A close-up of the result alone: which of the removed things can you still see? Each thing is
   named on its own: a label like "coffee table with tray and vase" is asked as three names
   (`schemas.parts`). Asked as one, the VLM said no while the vase floated in mid-air.
3. The same close-up: is there a patch, a shadow or a glow with nothing to cause it? Each is graded
   none, faint or clear. Only "clear" becomes an issue.
4. The same close-up: does anything float, with nothing under it to hold it up? Whatever it names is
   dropped if the same question on the original's close-up names it too (a hanging lamp, a shelf).
   It caught 2 of 3 floating leftovers and named nothing in 66 other pictures. It misses a lamp it
   decides is "wall-mounted", so the real fix is in the locator (see
   [Locating clutter](#locating-clutter)).
5. After a removal, about the request's own words, on the whole original and the whole result, each
   alone (`request_question`): how many of each thing the request names can you see, and, where the
   place stays ("on the bed"), which things are on it? Questions 2 to 4 ask only about the locator's
   names, so they cannot see what the locator missed; this one can, the way the retexture check asks
   whether the thing now looks as the request says. Read in `request_findings`:
   - A named thing still there orders a second removal only if the locator never boxed one. Where it
     did box some, the count is a note: the VLM counted the plain sleeping pillows left on a bed as
     "throw pillows" after every throw pillow had gone.
   - For "everything on" a place, a thing on it in the result that was on it before is a leftover.
   - For named things, a thing on the place that went and was not named is a note. It was a book that
     lay on the removed tray once, and a stool beside a nightstand that the VLM listed as on it.

More questions are asked about each place the scout marked. They are described in
[The second pass](#the-second-pass). A question with one 720 px crop takes 0.4 to 0.8 s, and the VLM
takes about 3 s to load once per check. The close-up takes in 30 % of the item's width and 20 % of
its height on each side: a wider one took in a look-alike side table, and the VLM said the removed
coffee table was still there.

Questions 2 and 3 are asked after a removal. They replaced an open "list the issues" question,
which made the 8B VLM report the same faint shadow for every picture. The VLM describes one picture
reliably and compares two pictures badly: in question 1 it said "done" for a picture in which
nothing had changed.

Tested on five results of known quality, with the VLM at 1024 px and at 768 px:

| Case | Verdict |
| --- | --- |
| Clean removal | pass |
| Faint lamp glow left on the wall | pass, with a note |
| Side table left behind | fix: `object_remains`, names the table |
| Nothing changed | fix: `object_remains` |
| Pasted patch with the lamp's shadow | fix: `shadow_left` |

With the VLM at 512 px (`draft`) the last case passes: the shadow is graded faint. At 720 px all
five give the verdicts above.

The questions say "a photo of a room" and "the wall and the floor", and views can be outdoors. A
wording that fits any place was tried and dropped: it answered "none" to all five cases, the pasted
patch included. With the room wording the VLM still names the removed things correctly on a street,
but it describes the ground as a wall and floor and does not find shadows there.

### The seam check

`visible_seam` is a number, not a VLM answer. The paste matches the model's tones to the original at
the border of the pasted area, so a clean paste changes nothing right at the border and more only
further in. `border_step` is the tone change in a thin band just inside the border (0.3 to 1.2 % of
the long side, 2 to 9 px at 720 px). It is the 90th percentile of that band and not the mean,
because a border usually shows along part of its length, where it crosses a surface the model
relit. Above 12 it is reported, with a box around the worst tenth.

An earlier version measured deeper in (1.5 to 3 %) and took the mean. It fired on the clean lamp
view, where the edit really did take the glow off the wall there, and it saw nothing when the pasted
area was small.

Tested without a model: five finished runs were pasted again in five ways each (as the graph does
it, without following the shadow, too small, without matching tones, and the last two together), and
every result was judged by eye.

| Result | `border_step` | Reported |
| --- | --- | --- |
| The 42 finished runs and replays so far | 2.0 to 9.9 | none |
| 16 re-pastes with no border to see | 3.6 to 10.3 | none |
| 4 re-pastes with a faint border or a soft patch | 12.2 to 20.8 | all |
| 5 re-pastes with a clear border | 15.8 to 96 | all |

The number is not a scale of how visible a border is. A faint border on a plain white wall measured
19, and a clear pale box on a wood floor 15.8. The lowest reported case (12.2, the bins pasted too
small with tones not matched) is hard to see at all. The highest clean values (9.9 and 10.3) are
from the run in which the model painted the wall grey. A leftover shadow or glow is not a seam and
is not reported as one: that is `shadow_left` or `light_left`.

## The second pass

The image model redraws the whole view, and the paste copies its picture back over the object and
over the object's shadow or glow. Inside that area other things can change too. On the lamp view the
glow covers the wall, and in two runs the baseboard under it went with the lamp. The second pass
finds that kind of damage and puts it right, once.

**1. The scout marks places** (`scout.py`, no model, 2 s). It compares the amount of edge in the
original and in the result, outside the object and inside the pasted area. Pixels cannot be
compared: the model redraws every texture, so they differ everywhere. A line that is gone, or a new
one, shows as a drop or a rise in edge. It looks right up to the object's outline (a ring of 0.8 % of
the long side is left out; at 3 % it missed the vent beside a fan blade). Up to six places go on,
strongest first, and asking about them stops once the answers have taken 5 s
(`Limits.scout_regions`, `Limits.scout_seconds`).

The scout cannot tell a shadow's edge that was rightly removed from a baseboard that was wrongly
removed. Both are edges that vanished next to the object. It also cannot see something the model
left in (nothing changed there) or anything inside the object's outline.

**2. The VLM names each place** (about 1 s per question). A red box marks the place on a crop of the
original, and on the same crop of the result. Each is asked once, alone: what is inside the red box,
and is it the target, a shadow, trim, another object or plain surface? The two answers are compared
in code. Asking the VLM to compare the two crops itself did not work: it answered "nothing gone"
for all 19 places tried, the deleted baseboard included.

| Before | After | What happens |
| --- | --- | --- |
| anything | the target | `object_remains`, severity 2, `action: remove_again` |
| target, surface or shadow | an object named like a removed thing | `object_remains`, severity 2, `action: remove_again` |
| trim | anything but trim | `damaged_neighbour`, severity 2, `action: restore` |
| object | surface or shadow | one more question, below: `restore` if separate, else a note |
| surface | object | `object_added`, a note: something may have been drawn in |
| shadow | surface | nothing. That is the shadow going with the object |

On 19 places from runs of known quality: the deleted baseboard was named trim before and not after
in 4 of 4, and the removed bins' shadow was named shadow then surface in 6 of 6.

An object that went is not always damage: it may be the item's own leg, or a vase that stood on a
removed dresser. Asked by name alone, the VLM once took the armchair's own leg for a table leg. So
the control question (`OWN_PROMPT`) is asked on the original crop with the item outlined in green
and the place in a red box: is the thing in the box "part" of the outlined object, "on" it, or
"separate"? Only "separate" is put back. Replayed: the vent beside the fan blade was called separate
and put back; the vases on the removed dresser were called "on" and stayed gone. With only "part"
and "separate" as answers, those vases were called separate and put back.

**3. The repair restores** (`steps.restore`, 1 s). In the marked boxes it puts back the original's
pixels plus the smooth tone change the edit made around them, so the baseboard returns in the wall's
new tone and not as a bright patch. The object is never brought back. A neighbour the model redrew
that a box touches is taken back whole: half original and half redrawn shows double (the wire table
in front of the baseboard did).

**Or it removes again** (`graph.remove_again`, about 40 s). A thing still visible, left floating, or
named at a scouted place is located again on the result by name, kept only where it lies inside the
first pasted area, cut out with SAM, redrawn and pasted. A thing the request names that the locator
never found (check question 5, `Issue.missed`) is looked for anywhere. This costs a second image
generation, so it runs only when the check reports a leftover.

When the request names a place things stand on ("on the dresser", "from the bed"), each box the second
locate finds must stand on that place or float, by the same question as the first pass's filter
(`BELONG_PROMPT`: what is the surface under it?), asked on the first result, where the box was found.
On the result, the plant pot whose base the removed vase had hidden is seen standing on the floor, a
lamp shade whose base went is seen floating, and the tray on the bed is on the bed. Without a place,
a leftover is asked about on the original with the first outline in green (`OWN_PROMPT`) and is taken
unless it is a separate thing.

Two older rails also keep it from removing what should stay. A
leftover found at a scouted place must have been an object there in the original too, not plain
surface. And the second cut-out may not be larger than the first: a leftover is part of what was
removed. Neither rule names a kind of furniture. Both guard against one failure, the VLM giving a kept
neighbour the name of what was removed, which happened three times in the 19 views of the 20:00
suite. Asked to clear a
coffee table, it called the table's own white top "a white oval tray with gold frame", and the second
removal took the whole table (its outline was twice the first). Asked to remove a vase from a
nightstand, it took the blue stool beside it for "a blue ceramic vase", and the second removal took
the stool (3.9 times the first). Replayed under the rails, both keep the furniture: on the table the
first rule drops the false leftover (the original showed table top there, not an object), and on the
nightstand the second refuses the cut-out. Real leftovers are smaller: a vase left floating measured
0.16 of the first outline.

The image model is told to remove only what the second locate took, by name ("Remove the dark grey
tray and the box."), not the locator's whole instruction. With the whole one, after the bed's yellow
blanket had been refused as "a yellow textured throw pillow", it was still told to remove that pillow:
it removed the blanket under the tray, and the shadow-following paste carried the blanket's change in
as part of the tray's effect. The check then passed the picture.

In a view carried from another one by `all_views` (`carried`), the mesh has already said where each
removed thing is. There nothing counts as missed, and a box the second locate finds must lie mostly
inside the carried outline, grown by 2% of the view (`CARRIED_REACH`). This is the rule that refused
the blanket in three views of the bed, where the paste area took in most of the bed. A name the rule
refuses everywhere becomes a note, as a separate thing does.

A thing the image model drew (`object_added`) was never in the original, so neither rule fits it. It
is taken where it lies mostly inside the paste area, in any view: only there can this edit have drawn
it. One found outside the paste was in the original all along, missing from the VLM's first list, so
it stays and the alarm becomes a note.

The rails missed a third case, which the place question now catches. Asked to remove a coffee table
and everything on it, the check said "still visible: vase" about the dark pot of a tall plant behind
the sofa, and the second removal took the plant. Asked on the first result, the place question
answers "separate, on wooden floor", so the pot is kept.

When every box the second locate finds is judged not to belong, nothing is taken and the leftover was
a false alarm. The state records it as `cleared` (what, and the second look's answers), and the next
report turns that issue into a note, so the run can end `pass`.

A second removal draws on the first result, not on the view, so its drift (`wrong_picture`) is
measured against the picture it was given (`raw_from`). Measured against the view, it also counted
the first redraw. A dresser pasted whole drifted 34, and its lamp shade's redraw added 6 more: 40, over
the limit, though the second redraw kept the picture (11 against the first result).

Replayed with both filters, 20:43 to 20:55, on nine views from their stored first pass (one fresh,
so the locator ran too; the last three after the fixes above):

| Request | What happened | Verdict |
| --- | --- | --- |
| remove the coffee table and everything on it | the plant pot behind the sofa: "separate, on wooden floor", kept; a note | `pass` |
| remove everything on the coffee table | the table's lower shelf, called "two-tiered mirrored tray", stands on the rug: kept; a note | `pass` |
| remove the dresser and everything on it (fresh) | the first-pass filter drops the black tray on the bed (under it: "bed") | `pass` |
| remove the dresser and everything on it | the lamp shade left floating is removed a second time | `pass` |
| remove everything on the dresser | question 5 finds three vases still there; the second removal takes them; the wall art above stays | `pass` |
| remove the tray and the throw pillows from the bed (3 views) | question 5 finds the tray the locator missed in one view and three yellow throw pillows in another; both go in the second removal | 2 `pass`, 1 `fix` |
| remove the blue vase from the nightstand | the stool beside it is no longer called a vase | `pass` |

Known limits after these replays:

- In one bed view, a white pillow with blue trim that the throw pillows hid is reported as a leftover,
  because the scout's place shares the word "pillow" with what was removed. The picture is right and
  the report is wrong. A word rule for it would be a special case, so it is left.
- In another bed view, the stored first pass also took the yellow blanket the tray lay on. No check
  reports it, because the blanket lay inside the item's outline.
- The VLM counts plain white sleeping pillows as throw pillows. So a request word's count orders a
  second removal only for a name the locator never boxed; for a boxed name it is a note.

Then measure, inspect and report run again. If the new report is worse, the first result is kept.
`Preset.max_repairs` is 1.

Replayed on seven finished runs (`raw` input, no image model): both runs with the deleted baseboard
were repaired, and the scout then found nothing there. The five clean runs were left alone. A repair
adds about 10 s: 1 s to restore, the rest to measure and ask the VLM again.

A finished run's `report.json` is a whole graph input, so any run can be replayed from its paste:

```
.venv\Scripts\python -m edit_agent.run --input ..\..\data\edit_agent\runs\<run>\report.json --name replay
.venv\Scripts\python -m edit_agent.scout ..\..\data\edit_agent\runs\<run>
```

The second command runs the scout alone and writes `scout.jpg` into the run folder: before and
after with the marked places, and a crop of each.

The VLM's names for a small place are not steady. The same spot by the armchair was "shadow under
table edge" in one run and "wooden leg of coffee table" in the next. That is why a lost object is put
back only after the control question, and other answers are notes.

## Removal and retexture in one graph

A `change` request (a new countertop, floor or pillow colour) runs through the same graph as a
removal. The steps that differ are switched on `target.kind`. The code for a change is
Mateo-Retexture-Agent's, in `edit_agent/change/` (its README has the reasons and the test suite).
The graph calls that code and does not copy it.

| Step | `remove` | `change` |
| --- | --- | --- |
| describe | skipped | The VLM, on a close-up of the item, fills the change block: `style` (recolor or restyle), `from`, `to`, `keep`, `form` (`change/spec.py`) |
| prompt | `steps.edit_prompt` | `change/wording.py`, from the block and the label only |
| paste | The item plus its shadow or glow, tones matched at the border | Inside the item only. A recolour pastes only the parts of the old colour. With `form: small` the new outline is pasted too (`change/paste.py`) |
| measure | `metrics.measure`, then the scout | `change/checks.measure`, then the scout |
| inspect | The four questions, the request question, the scouted places | `change/checks.inspect` (does it look like the request, is it new, is the old one still seen, does it look natural), the scouted places |
| report | The same shape for both: issues at `Limits.report_severity` (2) and above, the rest as notes | |

A change's issues come from `change/checks.flags`: `wrong_picture`, `not_applied`,
`shading_changed`, `form_changed`, and `shadow_left` or `light_left` at severity 1, which become
notes.

**Draw again.** An edit that failed outright has nothing to mend. For a removal that means another
picture (`wrong_picture`) or a masked area that barely changed (`object_remains` from the metric).
For a change it means another picture, or a thing that barely changed or took the wrong colour
(`not_applied`). Every severity-3 issue without a repair of its own gets `action: regenerate`.
The repair then runs generate and paste again with the next seed (`pass2/`, seed + 1) and keeps
whichever report weighs less, like the other repairs. This is the retry from the retexture
command line (`one(args, retries)` in `change/__main__.py`), borrowed for both kinds. As there, a
redraw stands in for the first pass, so it does not use up the one repair (`max_redraws` and
`max_repairs` in the preset, 1 each). A redrawn picture with a leftover still gets it removed. A
picture that failed outright again gets nothing more. A severity-3 leftover that the VLM still sees
keeps its own repair, `remove_again`.

Tested at 720 px on 2026-11-14, at 21:01 to 21:08, with three of the retexture suite's cached finder
results and two forced failures. A forced failure hands in the view itself as the image model's
picture, so the paste changes nothing.

| Run | First pass | Repair | Final | Expected |
| --- | --- | --- | --- | --- |
| pillows teal to red | pass (hue 1.7° off red, no teal left) | none | pass | pass |
| countertop granite to wood | pass | none | pass | pass |
| lamp to a metal one | fix: shading follows the photo at 0.11, outline overlaps 0.54 | none (severity 2) | fix | fix, for those two |
| pillows, forced failure | `not_applied` 3 | redraw, seed 43 | pass | pass |
| bed clutter, forced failure | barely changed 3, tray left 3 | redraw, then the tray removed | fix: a false "yellow pillow left" | pass |

The bed's final picture is right: the throw pillows and the tray are gone, and the sleeping pillows
and the blanket stay. The last check named a yellow throw pillow that is not there, the same misread
of the bed's own pillows as in the known limits under [The second pass](#the-second-pass). Each change run took 35 to 40 s; the bed took 92 s
for three drawings.

## Every panorama that sees the thing

A second graph, `all_views` (`edit_agent/panos.py`), carries an edit from the view the request was
made in to every other panorama that sees the thing. It runs `first_pass` once per view, one view at
a time, because the views share the one GPU.

```
first_view -> plan -> other_view -> other_view -> ... -> finish
     |          |
     +----------+-- a picture rather than a scan view, nothing edited, or no mesh: the first view only
```

| Step | What it does |
| --- | --- |
| first_view | `first_pass` on the starting view, as from the command line: locate, segment, generate, paste, the checks, at most one repair |
| plan | Lifts what that view removed onto the scan mesh as 5 cm voxels, one box at a time, and picks the other panoramas: each must see at least 30% of the voxels and stand at least 0.8 m from them, the best-seeing first, up to 4 views in all. Each gets a square view framed on the thing |
| other_view | Finds each lifted box in the new view (the mesh's outline, sharpened by SAM, less the surfaces next to it that the first view left out), then runs `first_pass` with that target and mask, so locate and segment are skipped. A box the view cannot see is left out there |
| finish | `views.json` and `views.jpg` (before and after, one row per view) in the run folder, and an overall verdict: `pass` only if every view passes |

Why the views are found through the mesh and not asked of the VLM again: every view then edits the
same things. A VLM asked in each view may take a different set of pillows. The tools for this
(lifting, framing, the SAM outline) are Mateo-Retexture-Agent's, in `change/views.py`.

Why box by box: SAM keeps one outline per prompt, and three pillows and a tray are four outlines.
It is also faster. The mesh cast tests each ray against every triangle in the cone of all its rays,
so one wide region costs far more than the same pixels in narrow pieces. On the bed, planning took
136 s for the whole area and 21 s box by box.

A removal is not made to agree across views: the floor or wall behind the thing is not on the mesh,
so each view draws its own. A `change` lifts the thing whole, and each view also gets the first
view's result drawn into its own viewpoint (retexture's `guide`) when that covers at least half of
the thing, so the new colour or texture matches. That path is written and has not been run through
this graph.

The image model in another view is told only what that view sees, by the labels of the parts found
there: "Remove the lamp and the green cup and every vase." A thing a second removal took in the first
view (a tray the locator missed) is one of the parts. The first view's own sentence is not reused: it
said "Leave the tray with box as it is" about a tray on the bed, which the dresser's other side does not
show, and there the image model drew a tray with a box on the cleared dresser.

Each other view runs `first_pass` with `carried` set, which changes its second pass: nothing counts
as missed, a leftover must lie inside the outline carried through the mesh, and a name found outside
it is cleared as a false alarm. See [The second pass](#the-second-pass).

Run it from `tools/edit_agent/`:

```
.venv\Scripts\python -m edit_agent.panos --scan zzvymDx5ty7 --pano 6 --yaw 270 --pitch -14 --fov 70 --request "remove the tray and the throw pillows from the bed"
```

The input is `first_pass`'s, with a `scan` view, plus `max_views`. The result:

| Field | Meaning |
| --- | --- |
| `views` | One record per edited panorama, the first one first: `{view, pano, yaw, pitch, fov, scan, run_dir, before, edited, paste_mask, mask, verdict, summary, issues, notes, repairs, seconds}`. `before` is the rendered view and `edited` the result, both the size of the working image; `yaw` and `pitch` are in the world frame, `fov` is horizontal. Other views also carry `distance_m`, `seen`, `hidden` (boxes not seen there) and `found` (SAM's numbers) |
| `skipped` | Panoramas that saw the thing and were left out, and why |
| `single_view` | Why only the first view was edited, when that happened |
| `share` | For each panorama, the share of the thing it sees |
| `report` | `{verdict, summary, views, sheet}` |
| `folder` | `data/edit_agent/runs/<time>-<name>/`, with one `p<pano>/` folder per view (a `first_pass` run folder each) and `lifted/` (the voxels) |

Progress: every `custom` event of a view carries `view` (0 for the first) and `pano`: the graph's own
`first_view` and `other_view_<n>` steps, and each view's `first_pass` steps, which are passed on as
they are. `plan` and `finish` belong to no view and carry neither; `plan` also sends
`{"step": "plan", "status": "chosen", "panos": [...]}` once it has picked the other views.

Results, 2026-11-14 evening, scan zzvymDx5ty7, preset 720, run from the command line and once through
the Agent Server:

| Request, starting view | Views | What came out | Time |
| --- | --- | --- | --- |
| "remove the tray and the throw pillows from the bed", pano 6 | 6, 2, 8, 1 | In every view the five throw pillows and the tray are gone, and the blanket, the sleeping pillows and the nightstands stay. Panos 2 and 8 pass. Panos 6 and 1 say `fix` for the check's misread of the blanket as "a yellow throw pillow" (pano 1's second removal took the rest of the tray at the door frame and refused the blanket). | 93 s first view, 20 s plan, 68, 66 and 96 s for the others: 5.7 min |
| "remove everything on the dresser", pano 6 | 6, 2 | The lamp, the vases and the cup gone in both, pass. Only pano 2 sees the dresser top well (0.92 of it; the next best 0.09) | 48 s, 18 s plan, 94 s: 2.7 min |
| "remove the grand piano", pano 6, through the server | 6 | `not_found`, `single_view`: nothing was edited in the first view | 5 s |

Two faults found on the way and fixed. In the first run of the bed, pano 1 lost its blanket and the
check passed it (the carried rule, in [The second pass](#the-second-pass)). In the first run of the
dresser, pano 2's image model drew a tray with a box, after a sentence about the bed's tray (the
instruction rule above), and the check passed it (`object_added`). Replayed on that result, the second
removal took the drawn tray and box in 35 s.

An other view costs its `first_pass` (35 to 55 s without a repair, about 80 with one) plus 15 to 60 s
for its outlines: the mesh cast grows with the thing's size in the picture, and the dresser top
fills half of the view framed on it.

## Handing in a target

Another part of the system may find the thing itself, from a click or from a search of the scan.
It hands the result in as `target`, and the graph skips locate:

```json
{"item": "white lamp with glass base", "kind": "remove",
 "behind": "A white wall with a white baseboard and a wood floor.",
 "instruction": "Remove the white lamp with the glass base.",
 "boxes": [{"label": "white lamp", "bbox_2d": [283, 172, 412, 372]}]}
```

- `bbox_2d` is `[x1, y1, x2, y2]` on a 0-1000 scale of the picture, the scale Qwen3-VL writes. It
  does not depend on the resolution.
- `kind` is `remove` or `change`. `behind` (the VLM's words for the surfaces where the thing was) is
  still required but is no longer passed to the image model. The image model sees the picture
  itself, and it obeys a wrong description: "gray wall, no baseboard" repainted a white wall grey
  and deleted its baseboard (the `interior-lamp` case).
- Each box's `label` is what the check looks for afterwards, so it should name the object plainly.
- For a `change`, the target may carry the change block as `change`: `{"style": "recolor",
  "from": "teal", "to": "red", "keep": "grey pattern, piping", "form": "none"}`. Without it, the
  describe step fills it in.
- With a `mask` as well (any size, white = the item), segment is skipped too.
- On the command line, `--input found.json` takes a whole graph input (`request`, `image` or `scan`,
  `target`, `mask`) from one file. A `report.json` from an earlier run works as `--target`.

Measured at `draft`: 16 s with target and mask, 20 s with target only.

**Sharing the GPU.** Any code on this PC that loads a model must do it inside `gpu.vlm(preset)` or
`gpu.exclusive()` from `edit_agent/gpu.py`. They hold a file lock (`data/edit_agent/gpu.lock`), so
two processes wait for each other. Without it they run out of memory or collide on the VLM's port.

## Models per role

`config.py` has one `Role(provider, model)` per job. Today there is one role, `eyes`, and it is the
local VLM. `steps.look` refuses to send a picture to any provider but `local`. A text-only planning
role can later use a hosted model (`provider="anthropic"`); that path is written in `models.py` but
has not been run.

## Not built, not verified

Not built: repairs for a leftover shadow or glow, a seam, a colour mismatch, and a change's
`shading_changed` or `form_changed` at severity 2. They are reported and not repaired. Something drawn
in is repaired only with "everything on" a place (`object_added`); with named things it is caught
only where the scout marks it, outside the item, as a note. Also
not built: adding objects, runtime skills, a Deep Agents coordinator, the demo UI. Removals in
several panoramas are not made to agree (each view draws its own floor or wall).

Known and not caught: the armchair's floor comes back paler where it stood, and every check passes.
A thing left floating that the locator missed and the VLM calls wall-mounted (the lamp on the
dresser, when the dresser was found as one box). Real shadows removed with a light (the driveway
under the lens flare).

Not built: a check that finds a shadow the image model left in on a street. Each view of the
exterior case is edited on its own, so the three results are not made to agree.

Not verified in `all_views`: a `change` (its guide path is written and has never run), a part hidden
in another view, the exterior through the mesh, more than the two clutter cases of one bedroom, and
the `object_added` repair inside a whole graph run (it was replayed on one result).

Not verified: a `change` through the graph beyond the three cases above (the rest of the retexture
suite runs through `change/__main__.py`, not the graph), a redraw on a real failure rather than a
forced one, pictures that are not square, the
`anthropic` provider, the limit for `visible_seam` on a border the graph made itself (every seam
it was tested on was made on purpose, and one person judged them), the scout's limits (first
guesses from 28 runs of two rooms and one street), the limits of the effect region (first guesses that worked on seven
runs), and the shadow sentence in the instruction on anything but the four test views. The restore
was tried on one kind of damage in one room. The check's five known cases are all from one room. The
interior test case has one view, and its angles were set from a contact sheet.

## Notes between sessions

`notes/` (git-ignored) holds working notes between the agent sessions on this PC: the brief for
the input side, and one file per session that the other one reads.

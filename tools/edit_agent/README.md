# Scan edit agent

A typed request such as "remove the table lamp" changes one view of a scanned room and reports what
is still wrong with the result. It is a LangGraph graph in Python over the local models in
[`tools/qwen_test/`](../qwen_test/README.md): Qwen3-VL-8B finds the thing, SAM 2.1 outlines it and
Qwen-Image-2.1 redraws the view. Everything runs on the PC that hosts those models. No picture
leaves it.

**Built so far: the first pass on one view, and one repair.** It removes an object and lists
glaring problems. It repairs one kind by itself: trim (a baseboard, a frame) that went with the
object is put back. See [The second pass](#the-second-pass). Other repairs, retexturing, adding
objects, skills and a Deep Agents coordinator are not built. See
[Not built, not verified](#not-built-not-verified).

## The first pass

```
prepare -> locate -> segment -> generate -> paste -> measure -> inspect -> report
                                              ^                               |
                                              +---------- repair <------------+  at most once
```

| Step | What it does | With |
| --- | --- | --- |
| prepare | Writes the working image: a picture you give, or a view rendered from a downloaded scan | Pillow |
| locate | Finds every object the request applies to (boxes), and writes the instruction for the image model | Qwen3-VL |
| segment | Outlines the object inside each box | SAM 2.1 |
| generate | Redraws the whole view from the instruction | Qwen-Image |
| paste | Puts the area around the object, plus its shadow however far it runs, back into the original, with tones matched at the border (see [Shadows](#shadows-and-the-difference-map)) | numpy |
| measure | Numbers: change outside the area, change inside it, the tone step at its border, tone shift, and how much of the object's shadow the paste missed. Also marks places where the edit removed or added edges outside the object (the scout) | numpy |
| inspect | Three short questions about the result (see [The check](#the-check)), and one per marked place | Qwen3-VL |
| report | Writes `report.json` and `sheet.jpg` | Pillow |
| repair | Only if an issue carries an `action`: acts on it, then measure, inspect and report run again (see [The second pass](#the-second-pass)) | numpy |

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

This is a local LangGraph Agent Server on `127.0.0.1:2025` with one graph, `first_pass`. Tracing is
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
| `edited` | Path to the edited picture. After a repair it is `edited_2.png`, and the first pass's `edited.png`, `report_1.json` and `sheet_1.jpg` stay in the run folder |
| `regions`, `repairs` | The places the scout marked, and what the repair did |
| `report` | `{verdict, issues, notes, scores, summary}`. `verdict` is `pass` or `fix` |
| `sheet` | Path to one picture of the run: before with boxes, mask with shadow and paste area, after with the issues marked, and a map of what changed |
| `run_dir` | The run folder, `data/edit_agent/runs/<time>-<name>/` (git-ignored) |
| `target`, `findings`, `timings` | What the locator found, the VLM's answers, seconds per step |

Each issue is `{kind, severity, source, evidence, region, repair, action}`. `severity` is 3 when the
edit failed, 2 when a problem is clear at a glance, 1 when it is faint. Faint findings go to
`notes`, not `issues`. `region` is `[x0, y0, x1, y1]` in pixels of the working image. `repair` says
in words what a second pass would do. `action` is set only when the graph can do it by itself
(today: `restore`). After a repair, `timings` has keys such as `measure_2`.

| Kind | Found by |
| --- | --- |
| `not_found` | The locator, or an empty SAM mask |
| `object_remains` | The VLM still sees the thing in a close-up, or almost nothing changed inside the mask |
| `not_applied` | The VLM, for a change request (not tested) |
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

## The check

The check is loose on purpose. It exists to catch what a first pass plainly got wrong, so that a
second pass has a short list. It asks the VLM three questions with fixed answers:

1. Before and after, side by side: was the change applied, and was a neighbour damaged?
2. A close-up of the result alone: which of the removed things can you still see?
3. The same close-up: is there a patch, a shadow or a glow with nothing to cause it? Each is graded
   none, faint or clear. Only "clear" becomes an issue.

A fourth kind of question is asked once per place the scout marked. It is described in
[The second pass](#the-second-pass).

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
one, shows as a drop or a rise in edge. The three strongest places go on.

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
| trim | anything but trim | `damaged_neighbour`, severity 2, `action: restore` |
| object | surface or shadow | a note. The VLM once took the removed armchair's own leg for a table leg |
| surface | object | a note: something may have been drawn in |
| shadow | surface | nothing. That is the shadow going with the object |

On 19 places from runs of known quality: the deleted baseboard was named trim before and not after
in 4 of 4, and the removed bins' shadow was named shadow then surface in 6 of 6.

**3. The repair restores** (`steps.restore`, 1 s). In the marked boxes it puts back the original's
pixels plus the smooth tone change the edit made around them, so the baseboard returns in the wall's
new tone and not as a bright patch. The object is never brought back. A neighbour the model redrew
that a box touches is taken back whole: half original and half redrawn shows double (the wire table
in front of the baseboard did).

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
table edge" in one run and "wooden leg of coffee table" in the next. That is why only trim, which
it named the same way every time, leads to a repair, and the rest are notes.

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

Not built: repairs for anything but removed trim. A leftover shadow or glow, a seam, a colour
mismatch, a neighbouring object that was removed and something drawn in are reported and not
repaired. Drawing the picture again as a repair is not built either. Also not built: retexturing as
a tested path, adding objects, runtime skills, a Deep Agents coordinator, edits across several
panoramas (that is in `tools/qwen_test/`), the demo UI.

Known and not caught: the armchair's floor comes back paler where it stood, and every check passes.
A thing that stood on the removed furniture and is left floating (coffee table, dresser). A
neighbour that touches the item and is removed with it (the vent beside the ceiling fan). Real
shadows removed with a light (the driveway under the lens flare).

Not built: a check that finds a shadow the image model left in on a street. Each view of the
exterior case is edited on its own, so the three results are not made to agree.

Not verified: a `change` request through the whole pass, pictures that are not square, the
`anthropic` provider, the limit for `visible_seam` on a border the graph made itself (every seam
it was tested on was made on purpose, and one person judged them), the scout's limits (first
guesses from 28 runs of two rooms and one street), the limits of the effect region (first guesses that worked on seven
runs), and the shadow sentence in the instruction on anything but the four test views. The restore
was tried on one kind of damage in one room. The check's five known cases are all from one room. The
interior test case has one view, and its angles were set from a contact sheet.

## Notes between sessions

`notes/` (git-ignored) holds working notes between the agent sessions on this PC: the brief for
the input side, and one file per session that the other one reads.

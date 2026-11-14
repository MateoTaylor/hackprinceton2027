# Scan edit agent

A typed request such as "remove the table lamp" changes one view of a scanned room and reports what
is still wrong with the result. It is a LangGraph graph in Python over the local models in
[`tools/qwen_test/`](../qwen_test/README.md): Qwen3-VL-8B finds the thing, SAM 2.1 outlines it and
Qwen-Image-2.1 redraws the view. Everything runs on the PC that hosts those models. No picture
leaves it.

**Built so far: the first pass on one view.** It removes an object and lists glaring problems. It
does not repair them. The second pass, retexturing, adding objects, skills and a Deep Agents
coordinator are not built. See [Not built, not verified](#not-built-not-verified).

## The first pass

```
prepare -> locate -> segment -> generate -> paste -> measure -> inspect -> report
```

| Step | What it does | With |
| --- | --- | --- |
| prepare | Writes the working image: a picture you give, or a view rendered from a downloaded scan | Pillow |
| locate | Finds every object the request applies to (boxes), and writes the instruction for the image model | Qwen3-VL |
| segment | Outlines the object inside each box | SAM 2.1 |
| generate | Redraws the whole view from the instruction | Qwen-Image |
| paste | Puts the area around the object, plus its shadow however far it runs, back into the original, with tones matched at the border (see [Shadows](#shadows-and-the-difference-map)) | numpy |
| measure | Numbers: change outside the area, change inside it, change at its border, tone shift, and how much of the object's shadow the paste missed | numpy |
| inspect | Three short questions about the result (see [The check](#the-check)) | Qwen3-VL |
| report | Writes `report.json` and `sheet.jpg` | Pillow |

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

### Result

| Field | Meaning |
| --- | --- |
| `edited` | Path to the edited picture |
| `report` | `{verdict, issues, notes, scores, summary}`. `verdict` is `pass` or `fix` |
| `sheet` | Path to one picture of the run: before with boxes, mask with shadow and paste area, after with the issues marked, and a map of what changed |
| `run_dir` | The run folder, `data/edit_agent/runs/<time>-<name>/` (git-ignored) |
| `target`, `findings`, `timings` | What the locator found, the VLM's answers, seconds per step |

Each issue is `{kind, severity, source, evidence, region, repair}`. `severity` is 3 when the edit
failed, 2 when a problem is clear at a glance, 1 when it is faint. Faint findings go to `notes`, not
`issues`. `region` is `[x0, y0, x1, y1]` in pixels of the working image. `repair` says what a second
pass would do.

| Kind | Found by |
| --- | --- |
| `not_found` | The locator, or an empty SAM mask |
| `object_remains` | The VLM still sees the thing in a close-up, or almost nothing changed inside the mask |
| `not_applied` | The VLM, for a change request (not tested) |
| `shadow_left`, `light_left` | The VLM, in a close-up of the edited area. Also numbers: the image model cleaned an area up and the paste kept the original there |
| `color_mismatch` | The VLM, in a close-up of the edited area |
| `damaged_neighbour` | The VLM, comparing before and after (not tested) |
| `visible_seam` | Change at the border of the pasted area (limit not calibrated) |
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

`cases/removal.json` holds the removal cases: one interior (an armchair) and one exterior (two
bins at the curb, from three panoramas). It names scans and views, not pictures. Only the request
and the view are chosen by hand. From `tools/edit_agent/`:

```
.venv\Scripts\python -m edit_agent.suite
```

It runs every view through the first pass and prints a table. Measured at 720 px: 38 to 41 s per
view, 156 s for the four, all pass.

## The check

The check is loose on purpose. It exists to catch what a first pass plainly got wrong, so that a
second pass has a short list. It asks the VLM three questions with fixed answers:

1. Before and after, side by side: was the change applied, and was a neighbour damaged?
2. A close-up of the result alone: which of the removed things can you still see?
3. The same close-up: is there a patch, a shadow or a glow with nothing to cause it? Each is graded
   none, faint or clear. Only "clear" becomes an issue.

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
- `kind` is `remove` or `change`. `behind` describes the surfaces to draw where the thing was.
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

Not built: the second pass that repairs the issues, retexturing as a tested path, adding objects,
runtime skills, a Deep Agents coordinator, edits across several panoramas (that is in
`tools/qwen_test/`), the demo UI.

Not built: a check that finds a shadow the image model left in on a street. Each view of the
exterior case is edited on its own, so the three results are not made to agree.

Not verified: a `change` request through the whole pass, pictures that are not square, the
`anthropic` provider, the limits for `visible_seam` and `damaged_neighbour`, the limits of the
effect region (first guesses that worked on seven runs), and the shadow sentence in the instruction
on anything but the four test views. The check's five known cases are all from one room. The
interior test case has one view, and its angles were set from a contact sheet.

## Notes between sessions

`notes/` (git-ignored) holds working notes between the agent sessions on this PC: the brief for
the input side, and one file per session that the other one reads.

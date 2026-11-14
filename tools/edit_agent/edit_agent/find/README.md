# Finder: the input side of the scan edit agent

The finder works out what the user wants to edit and hands it to the edit graph `first_pass` as a
`found.json`. That file is a whole `first_pass` input: `request`, `scan` or `image`, `target`, `mask`
and `preset`, plus a `find` record that the edit graph drops. Owned by Mateo-Input-Agent.

| Mode | The user gives | Command | State |
| --- | --- | --- | --- |
| click | a click in the current view, with or without words | `point` | built, tested on 23 clicks |
| view and words | the view they are looking at, and words | `look` | built: here first, then other directions and panoramas |
| words alone | words, and optionally the panorama they are at | `search` | built: a per-scan inventory, then locate |

Everything stays on this PC. Pictures go only to the local models. Run files go to
`data/edit_agent/find/runs/<time>-<name>/`, which git ignores.

## Command line

Run from `tools/edit_agent` with `.venv\Scripts\python`.

```
python -m edit_agent.find point --scan zzvymDx5ty7 --pano 1 --yaw 172.2 --pitch -11.9 --fov 75 --at 512,470
python -m edit_agent.find point --image PATH --at 512,470 --request "make this pillow blue"
python -m edit_agent.find point ... --highlight            SAM's outlines of the click only
python -m edit_agent.find point ... --mask OUTLINE.png     name an outline the user chose
python -m edit_agent.find look --scan zzvymDx5ty7 --pano 1 --yaw 213.1 --pitch -16.5 --request "remove the blue stool"
python -m edit_agent.find search --scan zzvymDx5ty7 --request "remove the table lamp" [--near 1]
python -m edit_agent.find inventory --scan zzvymDx5ty7 [--rebuild]
python -m edit_agent.run --input <found.json>              hand it to the edit graph
```

`--at X,Y` is on the 0-1000 scale of the view, the same scale as `bbox_2d`. `--preset` sets the
render size and the VLM's image size, and is passed on to `first_pass`. Without it the finder uses
`config.DEFAULT_PRESET`, which is `720` (720 px) since 2026-11-14 14:00.

## The graph `find_target`

```
START -> prepare -> highlight -> END                      (a click, highlight: true)
START -> prepare -> point -> write -> END                 (a click)
                      point -> recenter -> point          (the object is cut by the view's edge)
START -> prepare -> look -> deliver -> END                (a view and words)
START -> prepare -> search -> deliver -> END              (words alone)
```

The mode follows from the input. A `point` is a click. A `scan` with a `pano` and no `point` is a
view and words. A `scan` with only a `model` is words alone.

Input: `request`, `scan` {model, pano, yaw, pitch, fov} or `image`, `point` [x, y] on 0-1000,
`highlight`, `mask`, `preset`, `name`, `marker`, `near` (words alone: the user's panorama).
Output: `found`, `found_path`, `status` (`found`, `not_found` or `highlighted`), `reason`,
`candidates`, `default`, `several`, `sheet`, `run_dir`, `timings`.

For a click, `candidates` are SAM's outlines. For a search they are every place the thing was found,
each with its own `scan` view and `mask`, largest or nearest first. `several: true` means more than
one thing fits ("the table lamp" in a flat with three): the `found` holds the first, and a UI should
ask the user to pick.

Every node sends `{step, status, seconds, ...}` on the `custom` stream, like `first_pass`. The event
`{"step": "point", "status": "highlighted", "candidates": [...], "default": "c1"}` comes about 0.3 s
after the click, before the VLM has answered, so a UI can draw the outline at once.

## How a click becomes a target

1. **Highlight.** SAM 2.1 with the click gives up to three outlines, small to large: a part, the
   object, a group. Slivers and near copies are dropped. These are the `candidates` c0, c1, c2.
   The default is the one SAM scores highest.
2. **Ask.** The VLM (Qwen3-VL-8B) sees the view with a ring at the click and answers in the shape of
   the edit side's locate answer: found, item, kind, boxes, behind, instruction.
3. **Refine.** SAM again inside the VLM's box (outline A), and in each extra box the words named.
4. **Choose.** The default stands unless A is a larger or different thing. A larger thing is the
   lamp when the click hit its shade. A different thing is a thin faucet in front of a door, which
   SAM missed. When A lies inside the default, the VLM only boxed the spot under the ring.
5. **Grow.** For a removal, a larger outline is taken when what it adds sits on top of the chosen
   one, centred over it. A click on a side table then takes the lamp on it too, because the lamp
   would float otherwise.
6. **Describe.** The VLM names the chosen outline, drawn on a crop with the rest darkened. This
   name, not the first answer, goes into the target, so the target names what the mask holds.
7. **Checks.** A removal on bare wall, floor or ceiling returns `not_found`. The VLM says
   found=true for "white wall", so the words are checked: an item that ends in wall, floor or
   ceiling. When the VLM describes the ring itself ("a red circle on the wall"), its box is ignored
   and SAM decides.
8. **Recenter.** When the outline touches the view's edge, the view turns to centre it on the same
   panorama and the click is found again. The better of the two views is kept.

The mask is the whole object and nothing else: no shadow, no margin. The edit side's paste finds
the shadow itself.

## The SAM process

SAM runs in its own venv (`tools/qwen_test/.venv-sam`, torch with CUDA), so the finder keeps a warm
SAM process: `sam_click.py serve` on `127.0.0.1:2027`. The finder starts it when needed (about 4 s)
and it exits after 15 minutes without a request.

- The weights wait in CPU memory and move to the GPU for each request (0.2 to 0.5 s). Image
  features are cached per view.
- It takes the GPU lock for each request. A job with `"lock": false` skips that, for a caller that
  already holds the lock (the finder holds it across SAM and the VLM).
- While idle it holds about 400 MB of GPU memory (the CUDA context). The image model peaks at
  15 GB of 16.3 GB, so it fits.

## Results

Scan `zzvymDx5ty7`, preset `quality` (1024 px), field of view 75. One graph run per click, the VLM
loaded each time. ✓ right, ~ partly right, ✗ wrong.

| View | Click on | Got | | Seconds |
| --- | --- | --- | --- | --- |
| pano 1, yaw 213, pitch -17 | grey pillow | the pillow | ✓ | 7.6 |
| | grey pillow, "make this pillow blue" | the pillow, kind `change` | ✓ | 6.6 |
| | sofa seat | part of the sofa (back and one seat) | ✗ | 6.7 |
| | coffee table's mirror shelf | the table, without the tray and vase on it | ~ | 6.6 |
| | plant | the plant | ✓ | 6.7 |
| | painting | the painting | ✓ | 7.5 |
| | rug | the rug, after recentring | ✓ | 13.4 |
| | wall | not found | ✓ | 5.2 |
| | floor | not found | ✓ | 5.3 |
| pano 1, yaw 172, pitch -12 | lamp's glass base | the whole lamp | ✓ | 6.7 |
| | lamp shade | the whole lamp | ✓ | 6.6 |
| | side table under the lamp | the table and the lamp | ✓ | 6.7 |
| pano 4, yaw 38, pitch -12 | right decor ball | the ball | ✓ | 6.7 |
| | left decor ball | the ball | ✓ | 6.6 |
| | faucet | the faucet | ✓ | 6.6 |
| | countertop, "make this countertop black marble" | the countertop with the sink and balls in it | ~ | 13.4 |
| | wall | not found | ✓ | 6.5 |
| pano 7, yaw 260, pitch -10 | left green jar | the jar | ✓ | 6.7 |
| | right green jar | the jar | ✓ | 6.6 |
| | far sofa (small, across the room) | one cushion | ✗ | 6.6 |
| | far coffee table | the right outline, named "metal frame chair" | ~ | 6.7 |
| | track light | a wrong outline | ✗ | 6.6 |
| | floor | not found | ✓ | 5.2 |

17 right, 3 partly right, 3 wrong out of 23. Seconds per click: highlight 0.2 to 0.5; a whole
click 6.6 to 7.6, of which loading the VLM is 3.1; not found 5.2; with a recentre 13 to 14. The
first click after the SAM process starts adds 4 s.

Hand-off: the lamp-base click at preset `720` went to `python -m edit_agent.run --input found.json`.
`first_pass` used the given target and mask, removed the lamp in 29.8 s and kept the side table.

What misses: things far away and small (the far sofa, the track light), and a click on a large
object's part when SAM has no outline of the whole (the sofa seat). For those, a UI shows the
ladder and the user steps up to a larger outline, then sends it back with `mask`.

## How the click is shown to the VLM

Tested on the lamp view with a click on the base, the shade and the table, without words.

| Marker | base | shade | table |
| --- | --- | --- | --- |
| ring | base | shade | table |
| coordinates only | lamp | lamp | lamp (wrong) |
| ring and coordinates (default) | base | shade, box of the whole lamp | table |

The VLM ignores coordinates given alone and names the most visible object. It follows a ring. On
a busy surface such as a painting it can describe the ring itself, which the checks catch.

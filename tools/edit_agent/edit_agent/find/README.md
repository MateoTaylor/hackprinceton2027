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

## How a view and words become a target (`look`)

1. **Here.** The edit side's locate question on the user's view. If it finds the thing, SAM outlines
   it in each box and the finder is done.
2. **Elsewhere, with an inventory.** One text question picks the inventory names that fit the request
   (below). The views that name one are tried nearest panorama first, at most three, with locate.
3. **Elsewhere, without an inventory.** A yes/no question per view ("can the thing be seen?"): the
   other five directions of this panorama (60 degrees left and right first, behind last), then six
   directions of each of the two nearest panoramas. The first yes gets a locate. Each panorama is one
   hold of the GPU lock.
4. **Recentre or zoom.** When the found thing touches the view's edge, the camera turns onto it. When
   it is under 1 % of the view, the camera narrows (no tighter than 30 degrees) so that the edit has
   pixels to work with. The new view is kept if the thing is whole in it, or at least as large.

The `found.json` then holds the view where the thing is, not the user's view, so the UI can turn
there.

## How words alone become a target (`search`)

1. **Inventory.** Once per scan the VLM lists the removable or restyleable things in six views of
   every panorama ("blue velvet stool", "white table lamp"; no walls, floors, doors or windows). It is
   saved in `data/edit_agent/find/<model>/inventory.json` and reused. Scan `zzvymDx5ty7` (9
   panoramas, 54 views) took 61.5 s at preset `fast`, in three holds of the GPU lock of about 20 s.
   The first search on a scan builds it; `python -m edit_agent.find inventory` builds it ahead.
2. **Match.** The inventory names that hold every word of the request ("grey pillow" gives "grey
   throw pillow"). When none do (the request says "couch", or a new colour), one text question to
   the VLM, no picture, whose answer is limited to the inventory's names.
3. **Rank.** One view per panorama, the one naming the most matches. With `near` (the user's
   panorama) the nearest come first; without it, the panoramas that name the match most often.
4. **Locate.** The edit side's locate on the top three views. Every view where it finds the thing is
   a candidate. Without `near` they are sorted largest first.
5. **Merge.** The same lamp seen from three panoramas is one candidate. Each find is placed on the
   scan's mesh; finds in the same place merge, and the other views go in its `also` list.
6. **Recentre or zoom** the first, as in `look`.

When more than one thing fits (two lamps in different places, or one view with three pillows),
`several: true` and the reason ends "N things fit, ask the user". The finder never picks silently:
the UI shows the candidates and the user picks one.

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

### Clicks

Scan `zzvymDx5ty7`, field of view 75, at preset `quality` (1024 px) and at the default `720`. One
graph run per click, the VLM loaded each time. ✓ right, ~ partly right, ✗ wrong.

| View | Click on | 1024 px | 720 px |
| --- | --- | --- | --- |
| pano 1, yaw 213, pitch -17 | grey pillow | ✓ the pillow | ✓ the pillow |
| | grey pillow, "make this pillow blue" | ✓ the pillow, kind `change` | ✓ the pillow, kind `change` |
| | sofa seat | ✗ part of the sofa (back and one seat) | ✗ the same part |
| | coffee table's mirror shelf | ~ the table, without the tray and vase on it | ~ the same |
| | plant | ✓ the plant | ✓ the plant |
| | painting | ✓ the painting | ✗ not found: the VLM saw "white wall" |
| | rug | ✓ the rug, after recentring | ✓ the rug, after recentring |
| | wall | ✓ not found | ✓ not found |
| | floor | ✓ not found | ✓ not found |
| pano 1, yaw 172, pitch -12 | lamp's glass base | ✓ the whole lamp | ✓ the whole lamp |
| | lamp shade | ✓ the whole lamp | ✓ the whole lamp |
| | side table under the lamp | ✓ the table and the lamp | ✓ the table and the lamp |
| pano 4, yaw 38, pitch -12 | right decor ball | ✓ the ball | ✓ the ball |
| | left decor ball | ✓ the ball | ✓ the ball |
| | faucet | ✓ the faucet | ✗ the cabinet door behind it |
| | countertop, "make this countertop black marble" | ~ with the sink and balls in it | ~ the same |
| | wall | ✓ not found | ✓ not found |
| pano 7, yaw 260, pitch -10 | left green jar | ✓ the jar | ✓ the jar |
| | right green jar | ✓ the jar | ✓ the jar |
| | far sofa (small, across the room) | ✗ one cushion | ✗ one cushion |
| | far coffee table | ~ the right outline, named "metal frame chair" | ✓ the table and the plant on it |
| | track light | ✗ a wrong outline | ✗ a piece of the track |
| | floor | ✓ not found | ✓ not found |

At 1024 px: 17 right, 3 partly right, 3 wrong. At 720 px: 16 right, 2 partly right, 5 wrong. The
720 px run lost the thin faucet and the painting, where the VLM's view of the ring is coarser.

Seconds per click at 720 px: highlight 0.2 to 0.5; a whole click 5.9 to 6.8, of which loading the
VLM is 3.1; not found 4.9 to 5.8; with a recentre 12.2 to 12.3. At 1024 px each is about 0.5 s
more. The first click after the SAM process starts adds 4 s.

### Searches

Same scan, preset `720`, the inventory already built. `look` starts from pano 1, yaw 213, pitch -17
(the sofa view), where none of these things is in view.

| Command | Request | Got | Asks the user | Seconds |
| --- | --- | --- | --- | --- |
| `look`, no inventory | remove the table lamp | ✓ a lamp on this panorama, after 4 questions | no | 12.9 |
| `look` | remove the blue stool | ✓ the stool on this panorama, zoomed in from 0.3 % to 2.8 % of the view | no | 8.3 |
| `search` | remove the table lamp | ✓ both lamps in the flat: the ceramic one (two views merged) and the glass one | yes, 2 | 11.4 |
| `search` | make the refrigerator black | ✓ the refrigerator, whole after recentring | no (1) | 9.8 |
| `search` | remove the blue stool | ✓ the stool | no (1) | 18.1 |
| `search` | remove the grey pillow | ✓ three grey pillows on one sofa | yes, 3 | 10.9 |
| `search` | remove the couch | ✓ the living-room sofa; the teal armchair second | yes, 2 | 12.5 |
| `search` | remove the piano | ✓ not found (there is none) | no | 4.6 |

(1) These two ran before the merge and said "3 things fit". On their saved candidates the merge
gives one each. So did the table lamp's first run, whose three views all showed the ceramic lamp.

Before the merge every search that found its thing said "3 things fit": one object seen from
three panoramas. The merge casts 60 rays through each find's mask onto the scan mesh (0.1 s per
find). Two finds are one thing when the centre of either lies within 10 cm of the other's extent.
A scan without a mesh skips the merge.

The text match: names that hold every word of the request ("grey pillow" gives "grey throw
pillow") are taken as they are. Only otherwise does the VLM match: "couch" gives the sofas. The 8B
model alone, asked for "the grey pillow", returned every pillow but the grey one.

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

# 2838 Potomac Ave: fallback edit renders

Three edits of Matterport scan `ttiRpR6oEKM` ("2838 Potomac Ave", 29 panoramas), made on 2026-11-15
through the edit API (`tools/edit_api/`) on Mateo's PC with the `quality` preset (1024 px working
size). They are the demo's fallback if the live edit API is not used. Mateo decided to commit these
files, and only these (`AGENTS.md`, Data and secrets). Copy them nowhere else, and add no other
scan pictures to git.

| Folder | Command | Start view | Panoramas edited |
| --- | --- | --- | --- |
| `01-countertop-oak` | change the countertop from white marble to warm oak butcher block wood | pano 12, yaw 63.7, pitch -25.6, fov 70 | 12, 6, 17, 27 |
| `02-pillow-removed` | remove the red throw pillow from the round armchair | pano 23, yaw 78.2, pitch -21.3, fov 70 | 23, 4, 13, 16 |
| `03-doors-walnut` | change the white double doors to rich brown walnut wood | pano 13, yaw 302.4, pitch -4.6, fov 70 | 13, 21, 23, 12 |

Pano numbers are the `index` the API and the edit vis use, not Matterport's labels.

## Files

- `edits.json`: the three edits, their job ids and verdicts.
- `<edit>/edit.json`: the edit API's result for that job, in the format of "The result" in
  `tools/edit_api/README.md`, with each face URL replaced by a path. Each entry of `panos` has the
  panorama's `position` and `rotation` (world frame, see `frame`) and six `faces`.
  - A changed face is a file in the same folder: `p<index>_f<n>.jpg`, face `n` of that panorama,
    2048 px, the face layout from `AGENT_COMMS.md` Shared contracts (0 up, 1 +X, 2 -Y, 3 -X, 4 +Y,
    5 down).
  - An unchanged face is `original:data/ttiRpR6oEKM/panos/<pano id>/<n>.jpg`. `data/` is git-ignored
    and exists only on Mateo's PC. The edit API also serves it at
    `GET /places/ttiRpR6oEKM/panos/<pano id>/faces/<n>`.
- `<edit>/p<index>_v<k>_before.jpg`, `_edited.jpg`, `_mask.png`: the flat 1024 px view the pipeline
  edited, for a 2D before and after (mask white = changed). `preview.jpg`: all views, before and after.
- `combined.json`: all three edits at once. No face is changed by two edits, so taking each face from
  the edit that changed it is exact. A face is `<edit>/p<index>_f<n>.jpg` or `original:...`.

Every file except the JSON is a byte-for-byte copy of the job's output in `data/edit_api/jobs/`.
Nothing was retouched.

## What to know

- Each edit starts from the original panoramas. Shown alone, an edit's panoramas do not include the
  other two edits. Use `combined.json` for all three.
- An edit reaches at most four panoramas. Panoramas further away that also see the thing still show
  the original.
- Countertop: only the counter run left of the farmhouse sink changes. The run right of the sink
  stays white marble (visible in panos 6 and 27). A run over every counter edged the near counter in
  pano 12 badly and skipped pano 6, so it was not used.
- Doors: the verdict is `fix` with `shading_changed` in every view. That check fires on any change
  from white to a dark colour; the pictures were checked by eye. Small dark notches remain on the
  right door edge in pano 23.

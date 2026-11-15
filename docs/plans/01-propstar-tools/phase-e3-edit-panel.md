# Phase e3: Edit panel

Part of [the plan overview](overview.md).

Lane C, edit track, phase 3. It depends on [e2](phase-e2-edit-ops.md) and uses API port 8790 and
web port 5176. Read `docs/design/design.md` and run the **frontend-design** skill first.

## Goal

A user stands in a panorama, looks at a thing, types "remove the floor lamp" and sees the edit in
place. After this phase the Edit panel runs an edit end to end and shows it before and after.

## Changes

- Create `app/web/src/edit/panoCube.ts` with `createPanoCube(canvas)`, which returns a `PanoCube`.
  It draws with three.js, needs no Matterport viewer or SDK key, and `dispose` frees all it made.
  - `FACE_BASIS` copies `FACE_BASIS` from `tools/edit_api/places.py`. Forwards for faces 0 to 5 are
    +Z, +X, -Y, -X, +Y and -Z. Ups are -X, +Z, +Z, +Z, +Z and +X. `right` is `forward x up`.
  - `show` puts face `n` on a plane 1 unit along `forward`, image right along `right` and top along
    `up`. A parent turned -90° about X, which takes Z up to Y up, holds the cube at `rotation`.
    Faces load with `TextureLoader`, cached by URL. Dragging turns the camera and the wheel zooms.
- Create the pure `toEditView(forward, hfovDeg)` in `panoCube.ts`. It maps a three.js forward to Z
  up as `(x, -z, y)` and returns `yawDeg = atan2(y, x)` in 0 to 360, `pitchDeg = asin(z)` in -89 to
  89 and `fovDeg` in 30 to 120. `currentView()` passes `2·atan(tan(vfov / 2)·aspect)`.
- Fill `app/web/src/edit/EditPanel.tsx` and add `edit.css` beside it. Call
  `useOp('edit_places', {propertyId: property.id}, {detail: true})`, list panoramas by `label` and
  `floor`, and open the first downloaded one. Other scans read "Not on the edit PC yet". Faces load
  from `/api/edit/places/<modelId>/panos/<panoId>/faces/<n>`.
- Start sends `edit_start` with `{propertyId, modelId, panoId, command}` and `currentView()`. While
  queued, Cancel sends `fetch('/api/edit/edits/<jobId>', {method: 'DELETE'})`. A 409 hides it.
- Open `new EventSource('/api/edit/edits/<jobId>/events')`. Show the queue position and one line
  per `step` event, never branching on step names. Close it on `done`, `failed` and unmount.
- On `done`, call `callOp('edit_get', {jobId}, {detail: true})` and swap the faces in `changed`,
  with a Before and After toggle. Show `verdict` and `summary` beside them always. With
  `changedPanoCount` 0, keep the command box. A `failed` event shows its code.
- Create `panoCube.test.ts`. `toEditView` maps the three.js vectors `(1, 0, 0)`, `(0, 0, -1)`,
  `(-1, 0, 0)` and `(0, 0, 1)` to yaw 0, 90, 180 and 270 at pitch 0, and `(0, 1, 0)` to pitch 89.
  For every face, `right x up` equals `-forward`.

## Data structures

- `EditView`: `{yawDeg, pitchDeg, fovDeg}` in the edit API's world frame.
- `PanoCube`: `{show(rotation: [x, y, z, w], faceUrls: string[6]), currentView(), dispose()}`.

## Verification

1. Run `pnpm --dir app/web typecheck` and `pnpm --dir app/web test`.
2. Start the API on port 8790 and the web app on port 5176. Record both PIDs.
3. With the link down, open the Edit panel on `commercial-248243`. Screenshot the error and hint.
4. With the link up, on the property e2 recorded, run one remove command and one retexture
   command such as "change the blue pillows to red". Screenshot before and after each.
5. Keep screenshots, at 1440 by 900, in your scratchpad only. Check each against `design.md`.
6. Count `document.querySelectorAll('canvas').length`, open and close the panel five times and
   count again. The counts match. Stop both PIDs. Run the ownership check with `--lane lane-c`.
7. Stop here. The main session hands the edit diff to a reviewer subagent.

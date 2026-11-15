# Phase b6: Sign size and ground

Part of [the plan overview](overview.md).

Lane B, signage track, phase 1. It depends on [b5](phase-b5-surface-anchors.md). It uses API port
8789 and web port 5175.

## Goal

After this phase a sign on a wall has its own width and height, the scene remembers the ground
level under it, and the sign draws as a blank panel at that size.

## Changes

- In `app/server/src/ops/scene/document.ts`, add the optional fields `sizeM` and `groundY` to
  `SceneObject`.
  - `sizeM` is `{widthM, heightM}`, each from 0.2 to 20, rounded to 0.01. Only a row of class
    `sign` takes it. On any other row `scene_place` and `scene_move` throw `invalid_input`, and
    the hint says that only a sign can be resized.
  - A sign placed without `sizeM` gets it from its `EQUIPMENT` row, with `widthM` from `lengthM`
    and `heightM` from `stowedHeightM`. Every stored sign then has a size.
  - `groundY` is the height of the ground under the sign in the scene frame, rounded to 0.01. The
    browser measures it, because the mesh stays in the browser.
- In `ops/scene/index.ts`, `scene_place` accepts `sizeM` and `groundY`. `scene_move` accepts
  `sizeM`, `groundY` and `anchor`. A `scene_move` that changes `position` and sends no `groundY`
  deletes the stored one, because it belongs to the old place.
- A sign's `position` stays the centre of its back, as [b2](phase-b2-scene-document.md) says. Its
  bottom edge is at `position[1] - heightM / 2`. The sign hangs upright whatever the wall's lean.
- Create `app/web/src/scene/ground.ts` with `groundProbes(sign)` and `groundBelow(handle, sign)`.
  - `groundProbes` is pure. It returns three points at the height of the sign's bottom edge, 0.3
    m, 1 m and 2 m out from the bottom centre along the horizontal part of `anchor.normal`.
  - `groundBelow` casts a ray straight down from each point in turn through `handle.meshes()`. It
    returns the `y` of the first hit that `classifyNormal` calls `floor`, or `null`.
- Create `app/web/src/scene/signVisual.ts` with `buildSign(three, sizeM, depthM)`. It returns a
  `VehicleVisual` whose `root` origin is the back centre. The sign is a blank panel in `#F2F3F5`
  with a 0.03 m frame in `#2A2D32`. It carries no text, logo or texture. In `vehicles.ts`, the
  `sign` entry of `SHAPES` calls it.
- In `sceneSync.ts`, add `resize(objectId, sizeM)` and `setGround(objectId, groundY)`. Both call
  `scene_move`.
- In `ScenePanel.tsx`:
  - A sign placed or moved by click sends `groundY` from `groundBelow` in the same write.
  - After `load()`, each sign without `groundY` gets one `setGround` call. A sign that a model
    placed through the API gets its ground this way, the next time someone opens the space.
  - A changed `sizeM` rebuilds that sign's visual.

## Data structures

- `SizeM`: `{widthM, heightM}`.
- `SceneObject`: `{id, equipmentId, position, yawDeg, anchor?, sizeM?, groundY?}`.
- `scene_place` input gains `sizeM?` and `groundY?`. `scene_move` input becomes `{spaceId,
  objectId, position?, yawDeg?, anchor?, sizeM?, groundY?, expectedVersion?}`.
- `SceneResult.objects` carries `sizeM` and `groundY` when they are set.

## Verification

1. Run `pnpm typecheck` and `pnpm test` in `app/web` and `app/server`. `scene.test.ts` checks the
   default size from the row, `sizeM` on a forklift failing, a move of `position` clearing
   `groundY`, and 30 signs with both fields fitting under `RESULT_MAX_CHARS`. `ground.test.ts`
   checks the three probe points for a sign that faces +X.
2. Start the API on port 8789 and the web app on port 5175. Record both PIDs.
3. Open `EXTERIOR_SPACE_ID` from [b1](phase-b1-scene-host.md) and hang a sign on the outside
   wall. Take a screenshot at 1440 by 900 with `browser_take_screenshot` only. The sign is a
   blank light panel, flat on the wall.
4. Run `node docs/plans/01-propstar-tools/probe-op.mjs scene_get spaceId=<that space> --port 8789
   --show result.objects.0.sizeM.widthM --show result.objects.0.groundY`. It prints 2.4 and a
   number. If `groundY` is missing, record which probe distances found no ground.
5. Stop both PIDs. Run the ownership check with `--lane lane-b`.

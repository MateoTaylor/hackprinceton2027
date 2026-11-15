# Phase b5: Surface anchors

Part of [the plan overview](overview.md).

Lane B, scene track, phase 5, a milestone. It depends on [b4](phase-b4-vehicles.md) and on the
`sign_panel` row in [f4](phase-f4-equipment.md). It uses API port 8789 and web port 5175.

## Goal

After this phase a clicked object lands on the surface under the pointer, a sign panel hangs flat
on a wall, and a model can hang one through `scene_place` with a wall anchor.

## Changes

- Check that `EQUIPMENT` holds `sign_panel` with class `sign` and `mount: 'wall'`, and that every
  other row has `mount: 'floor'`. Without them, stop and ask the main session.
- Create `app/web/src/scene/anchors.ts` with `anchorAt(handle, pointer)`, `classifyNormal(normal)`
  and `yawFromNormal(normal)`.
  - `anchorAt` casts a `handle.three.Raycaster` from `handle.camera` through each mesh of
    `handle.meshes()`, which carry `boundsTree`. It takes the nearest hit, turns the face normal
    to world space and flips it when it points away from the camera.
  - `classifyNormal` reads `y`. At 0.866 or more it returns `floor`, at -0.866 or less `ceiling`,
    and between -0.342 and 0.342 `wall`. A ramp returns `null` and places nothing.
  - `yawFromNormal` returns `atan2(-z, x)` in degrees, so the object's +X faces along the normal.
- In `ScenePanel.tsx`, Place arms the item and lays a clear overlay on the viewer that takes one
  click, so Showcase does not move. Escape disarms.
  - A hit whose kind equals the row's `mount` calls `place` with the anchor. Otherwise the panel
    shows "Click the floor" or "Click a wall" and stays armed.
  - A wall hit places the back centre, with `yawDeg` from `yawFromNormal`.
- In `app/server/src/ops/scene/index.ts`, `scene_place` throws `invalid_input` when the anchor
  kind differs from the row's `mount`, or when a `wall` row has no anchor. The hint names the
  kind the row needs.
- Do not cut the wall anchor. The Signage tool in [b6](phase-b6-sign-size.md) to
  [b9](phase-b9-signage-panel.md) hangs its sign through it.

## Data structures

- `AnchorKind`: `'floor' | 'wall' | 'ceiling'`, the union of `Anchor.kind` in
  [b2](phase-b2-scene-document.md).
- `AnchorHit`: `{kind: AnchorKind | null, normal: [x, y, z], point: [x, y, z]}`.
- `pointer`: `{x, y}` in normalised device coordinates from -1 to 1.

## Verification

1. Run `pnpm typecheck` and `pnpm test` in `app/web` and `app/server`. `anchors.test.ts` checks
   `classifyNormal` on up, down, a wall, 25° and 35° from up and a 45° slope, and `yawFromNormal`
   on +X, -Z and +Z. `scene.test.ts` checks that `sign_panel` on a floor anchor fails.
2. Start the API on port 8789 and the web app on port 5175. Record both PIDs.
3. On the plant, place a forklift on the floor and a sign panel on a wall. Take a screenshot at
   1440 by 900. The sign lies flat on the wall, facing out.
4. Run `node docs/plans/01-propstar-tools/probe-op.mjs scene_place spaceId=L3sdz2m7jxp
   equipmentId=sign_panel position=[0,1,0] --port 8789`. It exits 1 with `invalid_input`.
5. Check the screenshot against `docs/design/design.md`. Stop both PIDs. Run the ownership check
   with `--lane lane-b`.
6. Stop here. The main session hands the scene diff to a reviewer subagent.

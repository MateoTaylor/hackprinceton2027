# Phase b4: Vehicles

Part of [the plan overview](overview.md).

Lane B, scene track, phase 4. It depends on [b2](phase-b2-scene-document.md) and
[b3](phase-b3-collider-drive.md). It uses API port 8789 and web port 5175.

## Goal

After this phase a user places a forklift or a scissor lift, drives it and finds it where it
stopped after a reload, and `scene_get` returns the scene on screen.

## Changes

- Create `app/web/src/scene/vehicles.ts` with `SHAPES`, `MOTION`, `buildVehicle(three,
  equipment)` and `driveSpecFor(equipment)`. Import `EQUIPMENT` from `app/server/src/model`.
- `SHAPES` is a `Record<EquipmentClass, ShapeBuilder>`, so a new class fails the build. Build
  from boxes and cylinders at the row's `lengthM`, `widthM` and `stowedHeightM`, one flat colour
  per class, with no logo or text. Port the scissor from `tools/world/src/lift-visual.ts` and the
  crate from `prop-visuals.ts`. A forklift is a body, a mast, two forks and four wheels. A `prop`
  row picks its shape by `id`. The `sign` class from [f4](phase-f4-equipment.md) is a thin panel.
- `MOTION` is a `Record<EquipmentClass, 'drive' | 'static'>`. Lifts, forklifts and pallet jacks
  drive. Props and signs get a fixed box from `addFixedBox`.
- `driveSpecFor` sets `halfM` to half of `lengthM`, `stowedHeightM - 0.1` and `widthM`,
  `rideHeightM` to `0.1 + halfM.y`, `wheelbaseM` to 0.75 of `lengthM`, 3 m/s and 0.7 rad.
- Create `app/web/src/scene/sceneSync.ts` with `createSceneSync(spaceId, onScene)`. It sends the
  last `version` as `expectedVersion` on every write.
  - `load()` calls `scene_get` and passes the `SceneResult` to `onScene`.
  - `saveSoon(objectId, pose)` calls `scene_move` once the speed stays under 0.05 m/s for 800 ms.
  - On a `conflict` it calls `load()`, and the panel rebuilds every object from the answer.
- `ScenePanel.tsx` lists `equipment_list` with a Place button per item, disabled when
  `placeable` is false. Place drops the object 3 m ahead of the camera, on the floor a ray cast
  finds. Without room it shows "No room here. Move the camera and try again."
- It lists placed objects. WASD drives the selected one, and Remove deletes it.

## Data structures

- `ShapeBuilder`: `(three, equipment) => VehicleVisual`.
- `VehicleVisual`: `{root, update(pose)}`. The origin of `root` is the base centre.
- `SceneSync`: `{load(), place(equipmentId, pose), saveSoon(objectId, pose), remove(objectId),
  dispose()}`.

## Verification

1. Run `pnpm --dir app/web typecheck` and `pnpm --dir app/web test`. `vehicles.test.ts` checks
   that every class has a shape and a motion. `sceneSync.test.ts` uses a fake `fetch` and
   `mock.timers` to check that three quick `saveSoon` calls send one `scene_move` and that a
   `conflict` leads to `scene_get`.
2. Start the API on port 8789 and the web app on port 5175. Record both PIDs.
3. On the plant, place a forklift and a scissor lift, drive the forklift and stop. Take a
   screenshot at 1440 by 900. Reload and take another. Both stand where they stopped.
4. Run `node docs/plans/01-propstar-tools/probe-op.mjs scene_get spaceId=L3sdz2m7jxp --port 8789
   --show result.objectCount`. It matches the screen. Record it in `decisions-lane-b.tsv`.
5. Check the screenshots against `docs/design/design.md`. Stop both PIDs. Run the ownership
   check with `--lane lane-b`.

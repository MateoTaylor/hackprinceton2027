# Phase b4: Vehicles

Part of [the plan overview](overview.md).

Lane B, scene track, phase 4. It depends on [b2](phase-b2-scene-document.md) and
[b3](phase-b3-collider-drive.md). It uses API port 8789 and web port 5175.

## Goal

After this phase a user opens the Insert tab, places a forklift, a scissor lift or a wheelchair,
drives it and finds it where it stopped after a reload, and `scene_get` returns the scene on
screen. Fahim asked on 2026-11-15 for licensed 3D models and an Insert tab, so a class with a
model file shows that model and every other class shows its shape built from primitives.

## Changes

- Create `app/web/src/scene/vehicles.ts` with `SHAPES`, `MOTION`, `buildVehicle(three,
  equipment)` and `driveSpecFor(equipment)`. Import `EQUIPMENT` from `app/server/src/model`.
- `SHAPES` is a `Record<EquipmentClass, ShapeBuilder>`, so a new class fails the build. Build
  from boxes and cylinders at the row's `lengthM`, `widthM` and `stowedHeightM`, one flat colour
  per class, with no logo or text. Port the scissor from `tools/world/src/lift-visual.ts` and the
  crate from `prop-visuals.ts`. A forklift is a body, a mast, two forks and four wheels. A
  wheelchair is a seat, a back, two large wheels and two casters. A `prop` row picks its shape by
  `id`. The `sign` class from [f4](phase-f4-equipment.md) is a thin panel.
- `MOTION` is a `Record<EquipmentClass, 'drive' | 'static'>`. Lifts, forklifts, pallet jacks and
  wheelchairs drive. Props and signs get a fixed box from `addFixedBox`.
- Create `app/web/src/scene/models.ts` with `MODELS` and `loadModel(handle, spec)`. `MODELS` is a
  `Partial<Record<EquipmentClass, ModelSpec>>`. The Models table in [findings.md](findings.md)
  lists the approved files. Both scissor classes share one model.
- `buildVehicle` returns the primitive shape at once. When `MODELS` names a file for the class, it
  loads the file and swaps the model in. When the file is missing or fails to load, the primitive
  shape stays, so a missing model never breaks the demo.
- Scale a model by one factor, so that its length equals the row's `lengthM`. Put its origin at
  the base centre and turn it by `yawDeg` so that it faces the way it drives. Keep the model's own
  materials. The collider stays the box from `driveSpecFor`, whatever the model looks like.
- The viewer bundles its own three, and no object from the app's `three` may enter its scene. If
  the Scene API in the `@matterport/webcomponent` README loads a glTF file, use it. Otherwise
  load with `GLTFLoader` in `models.ts` and rebuild each mesh with `handle.three` from the parsed
  attribute arrays and texture images. `models.ts` is then the one file that `imports.test.ts`
  lets import `three/addons`. Record the choice in `decisions-lane-b.tsv`.
- The scissor lift model carries one animation clip that raises its platform. Give a visual
  that can rise a `raise(fraction)` method, where 0 is stowed and 1 is fully raised. The model
  sets its clip to that fraction of the clip's length and does not play it. The primitive scissor
  moves its deck and folds its bars, as `lift-visual.ts` does. If the clip does not play in the
  viewer's scene, show the model stowed, leave `raise` off and record that.
- Keep the files in `app/web/public/models/` with a `LICENSE.md`. It gives each file's name,
  author, page link and licence, which a CC BY licence requires. Each file is a GLB or a glTF
  without Draco or meshopt compression, under 5 MB, with no maker's logo.
- Download the wheelchair yourself from the link in the Models table. It is CC0 and needs no
  account. Fahim downloads the forklift and the scissor lift, because Sketchfab needs a login. Do
  not log in to any service. If a file from Fahim is not there, leave its `MODELS` entry in
  place and go on with the primitive shape.
- `driveSpecFor` sets `halfM` to half of `lengthM`, `stowedHeightM - 0.1` and `widthM`,
  `rideHeightM` to `0.1 + halfM.y`, `wheelbaseM` to 0.75 of `lengthM`, 3 m/s and 0.7 rad.
- Create `app/web/src/scene/sceneSync.ts` with `createSceneSync(spaceId, onScene)`. It sends the
  last `version` as `expectedVersion` on every write.
  - `load()` calls `scene_get` and passes the `SceneResult` to `onScene`.
  - `saveSoon(objectId, pose)` calls `scene_move` once the speed stays under 0.05 m/s for 800 ms.
  - On a `conflict` it calls `load()`, and the panel rebuilds every object from the answer.
- `ScenePanel.tsx` gets two tabs, **Insert** and **Placed**. Take the tab style from
  `docs/design/design.md`.
- **Insert** lists `equipment_list`. Each item shows its label, its length, width and height, and
  a Place button that is disabled when `placeable` is false. Place drops the object 3 m ahead of
  the camera, on the floor a ray cast finds, and switches to **Placed** with the new object
  selected. Without room it shows "No room here. Move the camera and try again."
- **Placed** lists the placed objects. WASD drives the selected one, and Remove deletes it. A
  selected object whose visual has `raise` shows a **Platform height** slider from 0 to the row's
  `platformHeightM`. The height on screen is approximate, because a model is scaled by its
  length. The raised height lives in the browser only. It is not in the scene document, so a
  reload shows the lift stowed and `scene_get` does not report it.

## Data structures

- `ShapeBuilder`: `(three, equipment) => VehicleVisual`.
- `VehicleVisual`: `{root, update(pose), raise?(fraction)}`. The origin of `root` is the base
  centre.
- `ModelSpec`: `{file, yawDeg}`. `file` is a name under `public/models/`.
- `SceneSync`: `{load(), place(equipmentId, pose), saveSoon(objectId, pose), remove(objectId),
  dispose()}`.

## Verification

1. Run `pnpm --dir app/web typecheck` and `pnpm --dir app/web test`. `vehicles.test.ts` checks
   that every class has a shape and a motion. `models.test.ts` checks that `LICENSE.md` names
   every file in `MODELS`. `sceneSync.test.ts` uses a fake `fetch` and
   `mock.timers` to check that three quick `saveSoon` calls send one `scene_move` and that a
   `conflict` leads to `scene_get`.
2. Start the API on port 8789 and the web app on port 5175. Record both PIDs.
3. On the plant, take a screenshot of the Insert tab at 1440 by 900. Place a forklift, a scissor
   lift and a wheelchair, drive the forklift and stop. Take a screenshot. Reload and take
   another. All three stand where they stopped. Record in `decisions-lane-b.tsv` which classes
   showed a model and which showed the primitive shape.
4. Select the scissor lift, move **Platform height** to its top and take a screenshot. The
   platform stands raised.
5. Run `node docs/plans/01-propstar-tools/probe-op.mjs scene_get spaceId=L3sdz2m7jxp --port 8789
   --show result.objectCount`. It matches the screen. Record it in `decisions-lane-b.tsv`.
6. Check the screenshots against `docs/design/design.md`. Stop both PIDs. Run the ownership
   check with `--lane lane-b`.

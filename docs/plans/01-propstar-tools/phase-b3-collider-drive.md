# Phase b3: Collider and drive

Part of [the plan overview](overview.md).

Lane B, scene track, phase 3. It depends on [b1](phase-b1-scene-host.md). It uses API port 8789
and web port 5175.

## Goal

After this phase a box drives with WASD through the scan and stops at its walls.

## Changes

- Port from `tools/world/src/collision-mesh.ts`, and from `kinematicLift` and `addStaticWorld` in
  `tools/world/src/world.ts`. Read them. Do not edit `tools/world/`.
- Create `app/web/src/scene/collider.ts` with `buildCollider(handle)`, `mergeGeometry(parts)` and
  `addFixedBox(world, halfM, pose)`.
  - `buildCollider` awaits `RAPIER.init()` and adds one trimesh of `mergeGeometry` over
    `handle.meshes()`, with `FIX_INTERNAL_EDGES` and friction 0.9, once per space. It adds a catch
    floor 0.12 m below `min.y` and four 8 m walls outside the bounds, as `addStaticWorld` does.
  - `mergeGeometry` takes `{positions, indices, matrix}` per mesh, with `matrixWorld.elements` as
    `matrix`, and returns `{positions, indices, min, max}`. It numbers unindexed vertices and
    imports nothing. The arrays live only in memory.
- Create `app/web/src/scene/drive.ts` with `createDrivable(world, spec)`, `inputFromKeys(keys)`
  and `driveStep(state, input, spec, dtS)`.
  - `createDrivable` makes a kinematic body with one cuboid collider and a character controller
    of offset 0.02. Port `fits`, `clearMovement` and `groundUnder` for that one box.
  - `driveStep` is pure. Steer moves toward `input.steer * maxSteerRad` at 2.5 rad/s, speed toward
    `input.throttle * topSpeedMps` at 4 m/s². Yaw changes by `speedMps * tan(steerRad) /
    wheelbaseM * dtS`. It returns the next state and the wanted move `[dx, dz]`.
  - `inputFromKeys` maps W and Up to throttle 1, S and Down to -1, A and Left to steer 1 and D and
    Right to -1, by `KeyboardEvent.code`. Opposite keys cancel.
- `ScenePanel.tsx` builds the collider after the space mounts and steps the world at 1/60 s from
  `requestAnimationFrame`, 5 steps per frame at most. The status line adds `buildMs`.
- A Drive toggle spawns a grey 2.44 by 0.5 by 1.17 m box where a ray cast down from the camera
  meets the floor. If Showcase also moves on WASD, call `preventDefault` while Drive is on.

## Data structures

- `SceneWorld`: `{rapier, min, max, triangleCount, buildMs, dispose()}`.
- `DriveSpec`: `{halfM: {x, y, z}, rideHeightM, wheelbaseM, topSpeedMps, maxSteerRad}`.
- `DriveState`: `{speedMps, steerRad, yawRad}`. `DriveInput`: `{throttle, steer}`, each -1 to 1.
- `Drivable`: `{step(input), pose(), setPose(pose), speedMps(), dispose()}`. `Pose` is `{position,
  yawDeg}` in the frame of [b2](phase-b2-scene-document.md), with the body `rideHeightM` above.

## Verification

1. Run `pnpm --dir app/web typecheck` and `pnpm --dir app/web test`. `drive.test.ts` checks the
   4 m/s² limit, the top speed, no turn at rest, a left turn on positive steer and W with S
   giving 0. `collider.test.ts` merges one indexed and one unindexed triangle under a translation.
2. Start the API on port 8789 and the web app on port 5175. Record both PIDs.
3. Open the plant. Record `buildMs`, the triangle count and whether WASD moved Showcase in
   `decisions-lane-b.tsv`. Drive the box into a wall and take a screenshot at 1440 by 900.
   The box stops at the wall.
4. Stop both PIDs. Run the ownership check with `--lane lane-b`.

# Phase b2: Scene document

Part of [the plan overview](overview.md).

Lane B, scene track, phase 2, server only. It depends on [f6](phase-f6-server-scaffolds.md).

## Goal

After this phase four ops change one list of placed objects, and a stale write fails loudly.

## Changes

- Create `app/server/src/ops/scene/document.ts` with the Zod schemas `SpaceId`, `Anchor`,
  `SceneObject`, `SceneDocument` and `scenePath`, `readScene`, `writeScene`, `withSceneLock`.
  - `SpaceId` matches `^[A-Za-z0-9]{11}$`. `scenePath(dataDir, spaceId)` parses the id, then
    builds `<dataDir>/scenes/<spaceId>.json`. `readScene` returns version 0 with no objects when
    the file is missing. `writeScene` writes `<spaceId>.json.tmp` and renames it over the file.
  - `withSceneLock(spaceId, fn)` chains the writes to one space on one promise.
- Fill `app/server/src/ops/scene/index.ts`. Each write runs inside `withSceneLock`, checks
  `expectedVersion` first, raises `version` by one and writes.
  - A stale `expectedVersion` throws `conflict` with the hint "The scene is at version N. Call
    scene_get and retry with expectedVersion N."
  - An `equipmentId` missing from `EQUIPMENT` or not placeable throws `invalid_input` with a hint
    that names `equipment_list`. An unknown `objectId` throws `not_found`, naming `scene_get`.
  - A scene holds 30 objects at most, so `result` stays under `RESULT_MAX_CHARS`. Place number 31
    throws `invalid_input` with a hint that names `scene_remove`.
- Round coordinates to 0.01 m, `yawDeg` to 0.1 into 0 to 360 and normals to 0.001. An object id
  is `o-` plus the first 8 hex digits of a random UUID.
- Create `scene.test.ts` against a temp `dataDir` from `mkdtemp`. Test that each write raises
  `version` by one, that a stale version gives `conflict`, that `spaceId=../../etc` gives
  `invalid_input` and writes nothing, that place 31 fails and that 30 objects with anchors fit.

## Data structures

- `position`: `[x, y, z]` in metres in the Y-up frame of `handle.scene` from
  [b1](phase-b1-scene-host.md), not the Z-up scan frame in `AGENT_COMMS.md`. It is the centre of
  the object's base or, on a wall, of its back. `yawDeg` turns about +Y, counter-clockwise from
  above, and 0 faces +X.
- `SceneObject`: `{id, equipmentId, position, yawDeg, anchor?}`. `SceneDocument`: `{spaceId,
  version, objects}`. `Anchor`: `{kind: 'floor' | 'wall' | 'ceiling', normal: [x, y, z]}`.
- Inputs: `scene_get {spaceId}`, `scene_place {spaceId, equipmentId, position, yawDeg?, anchor?,
  expectedVersion?}`, `scene_move {spaceId, objectId, position?, yawDeg?, expectedVersion?}` and
  `scene_remove {spaceId, objectId, expectedVersion?}`.
- `SceneResult`, returned by all four: `{spaceId, version, objectCount, objects, assumptions}`.

## Verification

1. Run `pnpm --dir app/server typecheck` and `pnpm --dir app/server test`. Start the API on port
   8789 and record its PID.
2. Run `node docs/plans/01-propstar-tools/probe-op.mjs scene_place spaceId=L3sdz2m7jxp
   equipmentId=<id> position=[1,0,2] --port 8789 --show result.version` with a placeable id.
   Then run `scene_get`, and `scene_move` with `yawDeg=90`. Each write prints a version one higher.
3. Run `scene_move` with `expectedVersion=0`. It exits 1 with `conflict`. Run `scene_remove`.
   Record these lines in `decisions-lane-b.tsv`. Stop the PID. Run the ownership check with
   `--lane lane-b`.

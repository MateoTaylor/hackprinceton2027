# Phase r5: Mesh clearance

Part of [the plan overview](overview.md).

This phase is optional. The overview cuts it first when time runs short. Lane A, routing track,
phase 5. It depends on [r3](phase-r3-route-solve.md) and uses API port 8788.

## Goal

A scanned door gets its real clear width and free share from the MatterPak mesh on disk. After
this phase a half-open door or a cabinet in a doorway lowers the confidence of a route.

## Changes

- [f6](phase-f6-server-scaffolds.md) added `three` 0.187.0, `three-mesh-bvh` 0.9.18 and
  `@types/three` to `app/server`, the versions the web app pins. If one is missing, stop and
  ask the main session. Do not edit `package.json` yourself.
- Create `app/server/src/ops/route/mesh.ts` with `parseObj(text)`, `measureOpening(bvh, opening,
  scan)`, `meshFits(ctx, building)` and `MESH_FIT_VERSION = 1`.
- A scan lives in `data/<modelId>/` with a `manifest.json`, per `AGENT_COMMS.md` Shared
  contracts. `ctx.dataDir` is `data/propstar`, so check that `join(ctx.dataDir, '..', modelId)`
  reaches it. Skip a scan without a manifest or whose `mesh` entry is not `obj`. Never read
  `raw_locations.json`, which holds signed URLs.
- Port `parseObj` from `tools/world/src/collision-mesh.ts` without its Y-up conversion, so it
  keeps the scan's Z-up frame, and build a `MeshBVH` from it.
- Measure the `source: 'scan'` openings of each scan that covers one storey. Move each `at` into
  the scan frame by inverting `scan.transform`. Find the floor with `raycastFirst` pointing up
  from 0.5 m below the mesh's lowest point.
- Sweep a slice across the opening in 0.02 m steps, from 0.3 m beyond one jamb to 0.3 m beyond
  the other. A slice is a box 0.02 m wide, 0.4 m deep along the wall normal and from 0.1 m above
  the floor to the opening's height or `DEFAULT_DOOR_HEIGHT_M`. It is free when
  `bvh.intersectsBox` finds nothing. `clearWidthM` is the longest free run through the centre.
  `freeFraction` is the free share of the slices inside the API width.
- The sweep does not depend on the payload, so cache one per scan at
  `<dataDir>/cache/doorfit/<modelId>-<BUILDING_VERSION>-<MESH_FIT_VERSION>.json`. Write a
  temporary file and rename it, as [a7](phase-a7-building-op.md) does.
- [findings.md](findings.md) checked that the floor-plan frame equals the mesh frame on the
  warehouse scan only. If the centre slice is blocked on more than half of a scan's openings,
  drop that scan's fits and add an assumption that the frames differ.
- `doorFit` gains an optional `mesh` argument. With it, width clearance uses `clearWidthM`,
  `fitConfidence` gets `freeFraction` and `source` is `mesh`. `solveRoute` gains `meshFits`, a
  `Map` from opening id to `MeshFit`, empty by default. `route_solve` passes `meshFits(ctx,
  building)` and states how many doors the mesh measured.
- In `mesh.test.ts`, on a mesh built in code, a wall with a 0.9 m gap gives `clearWidthM` within
  0.02 m of 0.9 and `freeFraction` 1. A block in 0.1 m of the gap gives about 0.89. A scan with
  no manifest gives an empty map, a shifted transform trips the frame check, and `parseObj`
  turns a quad into two triangles.

## Data structures

- `MeshFit`: `{openingId, clearWidthM, freeFraction, source: 'mesh'}`.
- Cache file: `{modelId, fits: MeshFit[]}` as JSON. It derives from the scan and stays in `data/`.

## Verification

1. Run `pnpm --dir app/server typecheck` and `pnpm --dir app/server test`.
2. Start the API on port 8788 and record its PID. For each id a7 recorded, run the probe on
   `building_get` with `--detail --show detail.building.scans.0.modelId`. Check that
   `data/<modelId>/manifest.json` exists with `node -e` and `existsSync`, printing true or false.
3. If no scan has a mesh, record that in `decisions-lane-a.tsv` and skip to step 5.
4. Run the `route_solve` probe from [r3](phase-r3-route-solve.md) to a space of that scan with
   `--show result.doorCount`. It prints `200 ok`. Print the number of files in
   `data/propstar/cache/doorfit/`, and record it with the outcome of the frame check.
5. Stop the PID you recorded. Run the ownership check with `--lane lane-a`.

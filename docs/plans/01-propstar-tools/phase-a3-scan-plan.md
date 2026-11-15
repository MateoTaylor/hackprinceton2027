# Phase a3: Scan plan

Part of [the plan overview](overview.md).

Lane A, data track, phase 3. It depends on [f5](phase-f5-upstream-clients.md) and starts no
server.

## Goal

A Matterport floor plan becomes rings, openings and labels in the scan's own frame. After this
phase [a4](phase-a4-scan-placement.md) has a clean shape to place inside a storey.

## Changes

- Create `app/server/src/ops/building/scanPlan.ts` with `fetchScanPlan(ctx, modelId)` and
  `parseScanPlan(modelId, floorPlan)`.
- `fetchScanPlan` throws `not_ready` when `ctx.matterport` is `null`. The hint names
  `MP_TOKEN_ID` and `MP_TOKEN_SECRET`. Otherwise it calls `ctx.matterport.floorPlan(modelId)` and
  passes the answer to `parseScanPlan`.
- `parseScanPlan` is pure. For each room it chains `boundaryEdgeIds` into a ring by matching
  vertex ids end to end, and passes the ring through `orientCcw`. It drops a room whose edges do
  not close and counts it in `skippedRooms`.
- Compute each area from the ring. The API's room dimensions are imperial and the client does not
  fetch them.
- Place each opening along its edge with `relativeCenter`. First check what that number is. The
  live test below prints the smallest and largest `relativeCenter`, and the same after you divide
  by the edge length. Decide whether it is a fraction or a distance, and record the decision.
- Map `doorway` to `door` and `opening` to `opening`. A `doorway` on an edge that only one room
  uses is an `exterior_door`. `spaceIds` holds the rooms that share the edge. `bearingDeg` is the
  edge's normal.
- A floor's `outline` is the union of its room rings, computed with `clipper2-ts`.
- A space's label is the classification with the highest confidence, or the room's own label.
  Mark a room labelled `Staircase` with `stair: true`. The API has no stair type.
- Create `scanPlan.test.ts` with an invented plan. It has two rooms that share a door, one
  exterior door, one room that does not close and one staircase.
- Create `scanPlan.live.test.ts`. It skips without tokens. It fetches the scan `aYTUWzQVbUs` and
  prints counts and sizes only, which are floors, rooms, openings, skipped rooms, the two ranges
  of `relativeCenter` and the width and depth of the outline.

## Data structures

- `ScanPlan`: `{modelId, floors: [{id, sequence, label, outline, spaces, openings}],
  skippedRooms}`.
- `ScanSpace`: `{id, label, ring, areaM2, ceilingM | null, stair}`.
- `ScanOpening`: `{id, kind, at, widthM, heightM | null, bearingDeg, spaceIds}`.

## Verification

1. Run `pnpm --dir app/server typecheck` and `pnpm --dir app/server test`. The live test reports
   as skipped.
2. From `app/server`, run `node --env-file=../../.env --test
   src/ops/building/scanPlan.live.test.ts`. The outline is a rectangle that matches the shell's
   primary volume to within a metre. Record the
   printed counts in `decisions-lane-a.tsv`. Record nothing else.
3. Run the ownership check with `--lane lane-a`.

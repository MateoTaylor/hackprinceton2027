# Phase a7: `building_get`

Part of [the plan overview](overview.md).

Lane A, data track, phase 7. It depends on [a6](phase-a6-furnishings.md). It uses API port 8788.

## Goal

`building_get` is fast on the second call, never returns a broken model and works on three
building types. After this phase the look track and the routing track read real buildings.

## Changes

- Create `app/server/src/ops/building/build.ts` with `buildBuilding(ctx, property)`. It runs the
  steps in order, which are the shell, the storeys, the scan plans, the placement, the gap fill
  and the furnishings. `ops/building/index.ts` keeps only the op definition.
- Cache the answer at `<dataDir>/cache/building/<propertyId>-<BUILDING_VERSION>.json`. Write a
  temporary file and rename it, so a crash never leaves half a file. Raise `BUILDING_VERSION`
  whenever a step changes its output. The cache holds licensed data and stays under `data/`.
- Run `checkBuilding` before you return or cache. On any problem throw `internal`. The message
  gives the number of problems and no geometry.
- A scan that fails with `upstream` or `not_ready` goes to `unplacedScans` with that code as its
  reason. Return the building without it and do not cache that answer, so a later call can do
  better.
- Keep `result` a summary. The assumptions list holds 8 sentences at most, as
  [f1](phase-f1-op-contract.md) requires, so merge repeats before you return.
- Create `build.test.ts` with a fake `vexcel` and a fake `matterport` that return invented data.
  Test that the second call makes no upstream call, that a failed scan leaves no cache file and
  that a model which fails `checkBuilding` gives `internal`.
- Pick three building types. Run `node -e "fetch('http://127.0.0.1:8788/api/properties').then(r
  => r.json()).then(b => b.forEach(p => console.log(p.id, p.typeLabel)))"`. If the response
  wraps the list, adjust the path. Print the id and the type label only. Choose one office, one
  industrial property and one multifamily property, and record the three ids.

## Data structures

- `BUILDING_VERSION`: an integer in `build.ts`.
- Cache file: one `BuildingDetail` as JSON.

## Verification

1. Run `pnpm --dir app/server typecheck` and `pnpm --dir app/server test`.
2. Start the API on port 8788 and record its PID.
3. Run `node docs/plans/01-propstar-tools/probe-op.mjs building_get propertyId=<id> --port 8788`
   for each of the three ids. Each prints `200 ok`. Record the printed lines in
   `decisions-lane-a.tsv`.
4. Count the files in `data/propstar/cache/building/`. There are 3 or more. Print the count, not
   a file.
5. Run the probe with `propertyId=nope`. It exits 1 with `not_found`.
6. Stop the PID you recorded. Run the ownership check with `--lane lane-a`.
7. Stop here. The main session hands the data track's diff to a reviewer subagent.

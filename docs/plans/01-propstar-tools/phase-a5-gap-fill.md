# Phase a5: Gap fill

Part of [the plan overview](overview.md).

Lane A, data track, phase 5. It depends on [a4](phase-a4-scan-placement.md). It uses API port
8788.

## Goal

Every storey without a scan gets a plausible corridor, rooms, doors and a core, all marked as
inferred. After this phase a route can run from the entrance to any space in the building.

## Changes

- Create `app/server/src/ops/building/gapFill.ts` with `planCore(storeys, layout)`,
  `fillStorey(storey, core, layout, seed)` and the table `LAYOUT_BY_TYPE`.
- `LAYOUT_BY_TYPE` maps a property's `typeLabel` to `office`, `warehouse`, `apartment` or `open`.
  An unknown label gets `open`.
- `planCore` places one core for the whole building, so the connectors line up. It is a rectangle
  at the centroid of the smallest storey ring, aligned to that ring's longest edge. It holds one
  `elevator` and one `stair` connector with a landing on every storey. A building with one storey
  gets no core.
- `fillStorey` fills only the part of the storey that no scanned space covers. It skips a
  remainder under 10 m².
  - `office`: a corridor 1.8 m wide around the core, then rooms 4 to 6 m wide between the
    corridor and the outer wall, each with a 0.9 m door onto the corridor.
  - `apartment`: a straight corridor 1.5 m wide along the long axis, with units 8 to 10 m wide on
    both sides.
  - `warehouse`: one large space, an office strip 6 m deep on the entrance side and a 3 m dock
    door every 12 m along the longest edge of the ground storey.
  - `open`: one space.
- Use `clipper2-ts` for every offset, intersection and difference. The server has no
  `straight-skeleton` and no `d3-hierarchy`.
- The entrance is an `exterior_door` 1.8 m wide at the midpoint of the ground storey's longest
  edge, unless a scan already gave the ground storey an exterior door.
- On a storey that a scan covers, put each landing at the core's centre. If no scanned space
  contains that point, move it to the nearest point inside one.
- Seed `mulberry32` from a hash of the property id and the storey index. The same input then
  gives the same building.
- Give every generated space, opening and connector `source: 'inferred'` and a confidence of 0.3
  at most. Add one assumption that names the storeys the generator filled.
- Create `gapFill.test.ts`. For each fixture and three seeds, check that `checkBuilding` reports
  no problem and that a walk over openings and connectors reaches every space from the entrance.

## Data structures

- `Layout`: `'office' | 'warehouse' | 'apartment' | 'open'`.
- `Core`: `{ring, elevatorAt, stairAt}`.

## Verification

1. Run `pnpm --dir app/server typecheck` and `pnpm --dir app/server test`.
2. Start the API on port 8788 and record its PID.
3. Run `node docs/plans/01-propstar-tools/probe-op.mjs building_get propertyId=commercial-248243
   --port 8788 --show result.inferredShare --show result.counts.spaces`. The share is near 0.9,
   because one storey of 12 has a scan.
4. Stop the PID you recorded. Run the ownership check with `--lane lane-a`.

# Phase a6: Furnishings

Part of [the plan overview](overview.md).

Lane A, data track, phase 6. It depends on [a5](phase-a5-gap-fill.md). It uses API port 8788.

## Goal

Each space holds furnishings that match its label, so the dollhouse reads as a lived-in building.
After this phase `building_get` returns furnishings, every one of them marked as inferred.

## Changes

- Create `app/server/src/ops/building/furnish.ts` with `FURNISHING_TEMPLATES` and
  `furnishSpace(space, openings, seed)`.
- `FURNISHING_TEMPLATES` maps a space label to a list of kinds from `FURNISHING_KINDS`. Cover
  office, conference room, kitchen, bathroom, bedroom, living room, lobby, warehouse floor and
  plant floor. A space with an unknown label stays empty.
- Place items along walls first. A footprint from `FURNISHING_FOOTPRINTS` must lie inside the
  space ring, must not overlap another footprint and must stay 0.9 m clear of every opening.
  Check each with `clipper2-ts`.
- Lay racks in rows along the long axis of a warehouse space, with aisles 3.5 m wide.
- Place at most 40 furnishings in one space.
- Every furnishing has `source: 'inferred'`. Its confidence is 0.3 in a scanned space, where the
  label comes from the scan, and 0.15 in a generated space. Scans hold no furniture data.
- Add one assumption that says the furnishings come from room labels and not from the scan.
- This phase sends no image and no record anywhere. The alternative, which labels furniture from
  panorama crops with a hosted model, is open choice 2 in the overview. Do not build it here.
- If time runs short, the overview cuts the furnishing of scanned spaces first. Keep the
  templates for generated spaces.
- Create `furnish.test.ts`. Check that no footprint leaves its space, that openings stay clear
  and that the same seed gives the same list.

## Data structures

- `FURNISHING_TEMPLATES`: a map from a label to `[{kind, count, along: 'wall' | 'centre' |
  'rows'}]`.
- `furnishSpace` returns `furnishings[]` as [f3](phase-f3-building-model.md) defines them.

## Verification

1. Run `pnpm --dir app/server typecheck` and `pnpm --dir app/server test`.
2. Start the API on port 8788 and record its PID.
3. Run `node docs/plans/01-propstar-tools/probe-op.mjs building_get propertyId=commercial-248243
   --port 8788 --show result.counts.furnishings`. It prints `200 ok` and a count above 0. The
   size line stays under 6,000 characters.
4. Stop the PID you recorded. Run the ownership check with `--lane lane-a`.

# Phase a1: Shell

Part of [the plan overview](overview.md).

Lane A, data track, phase 1. It depends on [f7](phase-f7-web-scaffolds.md). It uses API port 8788.

## Goal

`building_get` returns the outside of a building, which is its volumes, its height and its
neighbours. After this phase the op answers for any property that Vexcel has measured, with
`storeys: []`.

## Changes

- Create `app/server/src/ops/building/shell.ts` with `pickCapture(features)` and
  `buildShell(property, own, neighbours)`. Both are pure, so their tests need no key.
- In `building_get`, call `ctx.vexcel.extract` twice. The first call has no buffer and
  `include: ['calculated']`, and it returns the property's own structures. The second call has
  `bufferM: 150` and `include: ['precomputed', 'calculated']`, and it returns the neighbours.
- `pickCapture` returns the features of the newest capture whose primary structure is over 3 m
  tall. Throw `no_data` when no capture qualifies. The hint says that Vexcel has no measured
  building at this point.
- `buildShell` sets `origin` to the property's `lat` and `lon`. `origin.groundElevationM` is the
  primary structure's roof elevation minus its height.
- Each structure of the chosen capture becomes one volume with `baseM: 0`, `topM` equal to its
  height, `primary` from the `primary-structure` flag and `source: 'vexcel'`. Pass each ring
  through `toEnu` and `orientCcw`. `shell.heightM` is the largest `topM`.
- Each neighbour becomes a `context` entry. Drop a neighbour whose `id` matches one of the
  property's own structures. A neighbour with no height gets 6 m, and one assumption states how
  many neighbours that was.
- Replace the `building_get` stub in `ops/building/index.ts`. Until later phases fill them, it
  returns `storeys`, `connectors` and `scans` as empty lists.
- Create `shell.test.ts` with invented features. Test that the newest capture wins, that a 2 m
  shed never becomes the primary volume, that a neighbour with no height gets 6 m and that every
  ring comes out counter-clockwise.

## Data structures

- `building_get` input: `{propertyId}`.
- `building_get` result: `{propertyId, heightM, counts: {volumes, neighbours, storeys, spaces,
  openings, furnishings, scans, unplacedScans}, inferredShare, assumptions}`.
- `building_get` detail: `BuildingDetail`.
- `inferredShare`: the share of floor area whose `source` is `inferred`. It is 0 while the
  building has no storeys.

## Verification

1. Run `pnpm --dir app/server typecheck` and `pnpm --dir app/server test`.
2. Start the API on port 8788 and record its PID.
3. Run `node docs/plans/01-propstar-tools/probe-op.mjs building_get propertyId=commercial-248243
   --port 8788 --show result.heightM`. It prints `200 ok` and a height near 55.
4. Run it again with `--detail --show detail.building.origin.groundElevationM`. The value is near
   36.5. Record both numbers in `decisions-lane-a.tsv`.
5. Run it with `propertyId=nope`. It exits 1 with `not_found`.
6. Stop the PID you recorded. Run the ownership check with `--lane lane-a`.

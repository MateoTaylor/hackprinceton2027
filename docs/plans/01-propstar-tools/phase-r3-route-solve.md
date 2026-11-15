# Phase r3: `route_solve`

Part of [the plan overview](overview.md).

Lane A, routing track, phase 3. It depends on [r2](phase-r2-door-fit.md) and
[a7](phase-a7-building-op.md) and uses API port 8788.

## Goal

An agent asks for the best route to a space for a payload and gets the length, a verdict per door
and a confidence. After this phase [r4](phase-r4-route-overlay.md) has a trail to draw.

## Changes

- Create `app/server/src/ops/route/payload.ts` with `PAYLOAD_PRESETS` and `resolvePayload(input)`.
  A preset is a `Payload` plus one assumption sentence. `person` is 0.55 by 1.9 m. Wheeled are
  `wheelchair` 0.70 by 1.4 m, `pallet_jack` 1.02 by 1.5 m loaded, `scissor_lift` 0.81 by 2.0 m
  stowed and `grand_piano` 0.75 by 1.65 m on its side. `custom` needs `widthM` and `heightM`.
- Create `solve.ts` with `solveRoute(building, target, payload)`. Build a `StoreyGrid` per storey
  and one `ngraph.graph`, with node ids `<storeyIndex>:<cell>`, data `{x, y, z}` and links from
  `neighbours` that cost their step length. A link into a failing opening's door cells from
  outside them costs `FAIL_PENALTY_M = 1000` more, so a failing door is a last resort.
- Join every pair of landings of each of `building.connectors`. A stair costs twice the rise and
  is closed to a wheeled payload. An elevator costs the rise plus 10 m and takes any payload, which
  is an assumption. A landing off the grid moves to a walkable cell within 1 m, else it drops.
- Link a node `start` at zero cost to every `exterior_door` cell on storey 0. Search with
  `ngraph.path` `aStar` and a heuristic of flat distance plus rise. Check in its readme whether
  the path comes back end first. A `{spaceId}` target ends at the space's cell nearest its
  `ringCentroid`. An `{at}` target needs `storeyIndex` and a walkable cell, else `invalid_input`.
- Walk the path. Record each opening when `doorIndex` changes to a new one. Turn cells into
  `trail` points with `cellCentre` and drop collinear points. `lengthM` leaves out the penalty.
  Route confidence is the lowest door confidence times the lowest `confidence` of an inferred
  space or connector on the route, or times 1 when there is none.
- Fill `route_solve` in `ops/route/index.ts`. Parse `ctx.call('building_get', {propertyId},
  {detail: true})` with `BuildingDetail`. An unknown `spaceId` is `not_found`, no storeys is
  `no_data`, a custom payload without sizes is `invalid_input` and no path is `reachable: false`.
  Assumptions name the payload, a default door height, the elevator rule and ignored furniture.
- In `solve.test.ts`, on invented buildings, a long wide way beats a short narrow door, the narrow
  door is taken with `failCount: 1` once the wide way is gone, and a wheelchair with only a stair
  is unreachable. A route reaches storey 5 of `FIXTURES.officeTower` in under 1 s, and the test
  prints the time. `index.test.ts` checks that 40 doors keep `result` under `RESULT_MAX_CHARS`.

## Data structures

- `RouteInput`: `{propertyId, target: {spaceId} | {at}, storeyIndex?, payload, widthM?, heightM?}`.
- `RouteResult`: `{reachable, target: {spaceId | null, storeyIndex}, lengthM | null, doorCount,
  failCount, doors, confidence | null, connector: {id, kind} | null, assumptions}`. `doors` is the
  first 20 `DoorFit` entries with `storeyIndex`. `connector` is the first one the route takes.
- `RouteDetail`: `{trail: [x, y, storeyIndex][], doors: (DoorFit & {storeyIndex, at})[], target:
  {storeyIndex, at}}`. The web imports both types with `import type`.

## Verification

1. Run `pnpm --dir app/server typecheck` and `pnpm --dir app/server test`.
2. Start the API on port 8788 and record its PID. Run the probe on `building_get` for
   `commercial-248243` with `--detail --show detail.building.storeys.5.spaces.0.id`.
3. Run `node docs/plans/01-propstar-tools/probe-op.mjs route_solve propertyId=commercial-248243
   target.spaceId=<id> payload=wheelchair --port 8788 --detail`. It prints `200 ok`. Record the
   printed lines in `decisions-lane-a.tsv`. With `payload=custom` it exits 1 with `invalid_input`.
4. Stop the PID you recorded. Run the ownership check with `--lane lane-a`.

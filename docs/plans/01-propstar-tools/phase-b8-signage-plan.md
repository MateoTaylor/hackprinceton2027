# Phase b8: `signage_plan`

Part of [the plan overview](overview.md).

Lane B, signage track, phase 3, on API port 8789. It depends on [b6](phase-b6-signage-rules.md),
[b7](phase-b7-lift-choice.md), [a7](phase-a7-building-op.md) and [c2](phase-c2-area-ops.md).

## Goal

A model asks what sign a building may carry and gets the allowance, a blank sign on the facade
and the lift that installs it. After this phase `signage_plan` answers for a Los Angeles property.

## Changes

- Create `app/server/src/ops/signage/zone.ts` with `zoneFor(dataDir, property)`. It opens
  `<dataDir>/zoning.duckdb` read-only per call and closes it, so `build:zoning` can still write.
  Of the `zones` rows whose box holds the point, ordered by `zone_cmplt`, it keeps the first whose
  outer ring holds the point by `pointInRing` and whose holes do not. It returns `{zone, source:
  'city'}` or `null`. A missing file throws `not_ready` with the hint to run `build:zoning`.
- Create `plan.ts` with the pure `planSignage({building, frontingStreet, signType, rules})`.
  - Use the `primary` shell volume, or else the tallest. The facade is the ring edge `a` to `b`
    whose outward normal `atan2(dy, -dx)`, in degrees from north, is closest to
    `frontingStreet.bearingDeg`. A tie goes to the longer edge. With no street, take the longest.
  - Parcel width is not in the data, so street frontage is the facade length, with `source:
    'inferred'` and `confidence: 0.5`. Call `signAllowance` with `storeys:
    building.storeys.length`, lengths in feet (`m / 0.3048`) and wall height `topM - baseM`.
  - For `wall`, size a 4 to 1 sign at `Math.min(wall.areaSqFt, allSignsSqFt)`, at most 80% of the
    facade wide and half its height tall, rounded down to 0.1 m. Centre it with its top 0.5 m below
    the wall top and its corners 0.05 m outward. For other types, `sign` and `lift` are `null`.
- Replace the `signage_plan` stub in `ops/signage/index.ts`. Call `requireProperty`, then
  `building_get` with `{detail: true}` parsed by `BuildingDetail`, then `area_summary` for
  `frontingStreet` only. On its `not_ready` or `no_data`, go on without a street and say so. Call
  `lift_choose` with `heightM: sign.mountHeightM`. A `null` from `zoneFor` throws `no_data`, with
  a hint that no City of Los Angeles zone covers the property.
- `assumptions` always says "subject to overlays", as a sign district or specific plan prevails.
  It names overlays, existing signs, window area, tenant count and ground type as not computed.

## Data structures

- Input: `{propertyId, signType = 'wall'}`. Result: `{zone, facade: {bearingDeg, lengthM,
  heightM, source}, frontage: {streetFt, buildingFt, source, confidence}, allowed, sign:
  {widthM, heightM, mountHeightM} | null, lift, unverified, assumptions}`. `allowed` has one
  entry per sign type with `areaSqFt` or `heightFt`, `section` and `checked`. `lift` is the
  `lift_choose` result without alternatives, or `null`.
- Detail: `{corners}`, the sign's four `[x, y, z]` corners in the building frame, or `null`.

## Verification

1. Run `pnpm --dir app/server typecheck` and `pnpm --dir app/server test`. On invented buildings
   and a temporary DuckDB file, the tests check the facade of a 40 by 20 m box for a street north
   and east, no street, a sign inside the wall and the allowance, and a point in a hole.
2. Start the API on port 8789 and record its PID. Run `node
   docs/plans/01-propstar-tools/probe-op.mjs signage_plan propertyId=commercial-248243 --port 8789
   --show result.sign.mountHeightM --show result.lift.class`. It prints `200 ok`. Repeat it with
   `--detail`, then with `propertyId=nope`, which exits 1 with `not_found`.
3. Record the printed lines in `decisions-lane-b.tsv`, and stop the PID you recorded.
4. Run the ownership check with `--lane lane-b`.

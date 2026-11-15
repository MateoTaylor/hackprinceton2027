# Phase c2: Area ops

Part of [the plan overview](overview.md).

Lane C, area track, phase 2. It depends on [c1](phase-c1-area-extract.md). It uses API port 8790.

## Goal

A model asks what is near a property and gets places, counts and the street it faces. After this
phase both area ops answer from the local extract, and `signage_plan` reads `frontingStreet`.

## Changes

- Create `app/server/src/ops/area/db.ts` with `openArea(dataDir)`, one read-only connection with
  `spatial` loaded. A missing file throws `not_ready` with the hint "Run `pnpm --dir app/server
  build:area`", and the next call tries again.
- Create `categories.ts` there with `AREA_GROUPS` (`food`, `grocery`, `transit`, `health`,
  `school`, `park`, `bank`, `fuel`) and `CATEGORY_GROUPS`, from `basic_category` to group. Fill it
  from the category counts, and record the top 60 in `decisions-lane-c.tsv`.
- Create `query.ts` there with `placesNear(db, property, radiusM)`, `frontingStreet(db, property)`
  and the `FrontingStreet` Zod schema. A property with no `covered` row throws `not_ready` with the
  hint "Run `pnpm --dir app/server build:area` again to cover this property."
- Work in EPSG:32611 with `ST_DWithin` and `ST_Distance` on `geom_utm`. `bearingDeg` is `atan2(dx,
  dy)`, 0 to 360. `placesNear` drops unnamed or ungrouped places, nearest first, ties by name.
- `frontingStreet` takes the nearest named segment within 150 m that is not `footway` or `service`,
  or `null`. Its `bearingDeg` aims at the end of `ST_ShortestLine` if `duckdb_functions()` lists it,
  or else at `nearestOnLine(point, coords)` over the line's points.
- Replace the two stubs in `index.ts`. Both set `source: 'overture'`. `area_places` puts `limit`
  places in `result` and up to 500 in `detail`. `area_summary` counts every group, zeros included.
- Every result lists these assumptions. "A straight line of `<radiusM>` m stands in for walking
  distance, and 800 m is about a ten-minute walk." "Places and streets come from Overture release
  2026-10-21.0." Place and street names are public Overture data, so both ops may return them.
- Create `area.test.ts` beside them on an invented `area.duckdb` in `mkdtemp`. Set
  `autoinstall_known_extensions = false` and skip when `LOAD spatial` fails. Check the sort,
  `group`, `limit`, that a `service` road never fronts, both `not_ready` cases and the size cap.

## Data structures

- `area_places` input `{propertyId, group?, radiusM = 800, limit = 10}`, `radiusM` an integer from
  50 to c1's reach of 1000, `limit` 1 to 25. Result: `{places: [{name, group, category, distanceM,
  bearingDeg}], total, radiusM, source, assumptions}`. `detail.places` adds `lat, lon`.
- `area_summary` input `{propertyId, radiusM = 800}`. Result: `{counts: Record<AreaGroup, number>,
  nearest: [{group, name, distanceM}], frontingStreet, source, assumptions}`.
- `FrontingStreet`: `{name, roadClass, bearingDeg, distanceM} | null`. Lane B reads these names.

## Verification

1. Run `pnpm --dir app/server typecheck` and `pnpm --dir app/server test`. Start the API on port
   8790 and record its PID.
2. Run `node docs/plans/01-propstar-tools/probe-op.mjs area_places propertyId=commercial-248243
   --port 8790 --show result.total`, then again with `group=food --detail`. Probe `area_summary`
   with the same id and `--show result.frontingStreet.distanceM`.
3. Probe `area_places` with `group=casino` and `area_summary` with `propertyId=nope`. Both exit 1.
   Record every printed line in `decisions-lane-c.tsv`. Stop the PID you recorded, then run the
   ownership check with `--lane lane-c`.

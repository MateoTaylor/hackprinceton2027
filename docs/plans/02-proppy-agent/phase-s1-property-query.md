# Phase s1: `property_query`

Part of [the plan overview](overview.md).

Phase 3. It depends on [f2](../01-propstar-tools/phase-f2-ops-http.md) of the tools plan, and on
[c2](../01-propstar-tools/phase-c2-area-ops.md) for the two area tables. It uses API port 8791.

## Goal

A model finds properties across the whole set with one query, such as "condos more than 300 m
from a highway". After this phase `property_query` runs one SELECT over three search tables, and
Proppy no longer needs a database connection of its own. The roads and places near each property
come from the Overture extract that the area ops read, so no question has a column of its own.

## Changes

- Create `app/server/pipeline/search.ts` and the script `build:search` in
  `app/server/package.json`. The main session adds the script line. The build writes
  `data/propstar/search.duckdb` with three tables, `search`, `near_roads` and `near_places`. It
  prints the row count of each table and the count of covered rows. It prints no name.
  - Attach `propstar.duckdb` read-only and copy the named columns under Data structures. Copy no
    other column, so `facts` and `photo_url` never enter the file.
  - With `area.duckdb` present, attach it and load `spatial`. Give each property a point in
    EPSG:32611, the zone that c1 uses. Every property is in Los Angeles, so that zone is right.
  - Fill `near_roads` with one row per property, road `class` and road `name`. `distance_m` is
    the least `ST_Distance` on `geom_utm` over the `segments` within 1000 m, which is c1's reach.
    An unnamed road keeps a null `name`.
  - Fill `near_places` with one row per property and place within 1000 m. `place_group` comes
    from `CATEGORY_GROUPS` in `app/server/src/ops/area/categories.ts`. Drop a place that has no
    name or no group, as `placesNear` does.
  - `area_covered` is true for a property with a `covered` row.
  - Without `area.duckdb`, both area tables are empty and `area_covered` is false.
  - First print the count of `segments` rows per `class`. If no `motorway` row exists, stop and
    ask the main session, because c1 then dropped them.
- Create `app/server/src/ops/search/index.ts` with `SEARCH_OPS`, and add it to `OPS`.
  - Open `search.duckdb` once with `access_mode: 'READ_ONLY'`, `enable_external_access: 'false'`
    and `lock_configuration: 'true'`. A missing file throws `not_ready` with the hint "Run
    `pnpm --dir app/server build:search`", and the next call tries again.
  - Move the statement check out of `app/agent/src/proppy.ts`. `extractStatements` must find one
    statement of type `SELECT`. Anything else throws `invalid_input`.
  - Run each query on its own connection. After 2 s, call `interrupt()` and throw `invalid_input`
    with the hint "Add a WHERE clause or a LIMIT."
  - Pass on the first line of a `Parser`, `Binder` or `Catalog` error, which quotes only the query
    and column names. Give every other error a fixed message, because a conversion error can
    quote a cell.
  - Read at most 100 rows. Drop rows from the end until `result` fits `RESULT_MAX_CHARS`, and
    set `truncated`.
- Put the three tables in the `describe()` text of the `sql` field: every column with its unit,
  the `class` values that the build printed, the `AREA_GROUPS` values and one example that joins
  `search` to `near_roads`. The manifest then carries it, and the model needs no skill to write
  a first query.
- Create `search.test.ts` on an invented `search.duckdb` in `mkdtemp`. Move the refusals from
  `proppy.test.ts`: a `DELETE`, two statements, a `read_text` call and an unbalanced bracket fail,
  and a trailing comment passes. Check `truncated`, the timeout and the size cap.

## Data structures

- `search` columns: `id, kind, name, address, lat, lon, type_label, year_built, building_sf,
  units, stories, beds, baths, price_usd, rent_usd_month, scan_count, area_covered`. It holds one
  row per property.
- `near_roads` columns: `property_id, class, name, distance_m`. `class` is Overture's road class,
  such as `motorway`, `trunk` or `residential`.
- `near_places` columns: `property_id, place_group, name, distance_m`. `place_group` is one of
  `AREA_GROUPS`. The column is not named `group`, because `group` is a reserved word in SQL.
- `distance_m` is a straight line in metres, at most 1000.
- `property_query` input: `{sql}`, at most 2000 characters.
- Result: `{columns: string[], rows: unknown[][], rowCount, truncated, assumptions}`. Rows are
  arrays in column order, which fits more rows under the size cap than objects do.
- Assumptions, on every result: "`near_roads` and `near_places` come from Overture release
  2026-10-21.0 and hold straight-line distances up to 1000 m." "A property whose `area_covered`
  is false has no row in either table."

## Verification

1. Run `pnpm --dir app/server build:search`. Record the printed counts in `decisions.tsv`.
2. Run `pnpm --dir app/server typecheck` and `pnpm --dir app/server test`. Start the API on port
   8791 and record its PID.
3. Run `node docs/plans/01-propstar-tools/probe-op.mjs property_query "sql=SELECT count(*) FROM
   search s WHERE s.area_covered AND NOT EXISTS (SELECT 1 FROM near_roads r WHERE r.property_id =
   s.id AND r.class IN ('motorway', 'trunk') AND r.distance_m < 300)" --port 8791 --show
   result.rows.0.0`. Record the number.
4. Probe `"sql=SELECT id FROM search" --show result.rowCount`, then `"sql=DELETE FROM search"` and
   `"sql=SELECT nope FROM search"`. The last two exit 1 with `invalid_input`.
5. Use `--show` on counts and ids only. Never show a `name` or an `address` cell. Stop the PID
   you recorded.

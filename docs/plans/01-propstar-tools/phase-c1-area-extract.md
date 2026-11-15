# Phase c1: Area extract

Part of [the plan overview](overview.md).

Lane C, area track, phase 1. It depends on [f6](phase-f6-server-scaffolds.md) and starts no
server. It reads public Overture data and needs no key.

## Goal

The Area ops get a local table of the streets and places around every property, so no op calls
out at request time. After this phase `<dataDir>/area.duckdb` holds the segments and places of
every grid cell that covers a property, and a stopped build resumes where it left off.

## Changes

- Fill `app/server/pipeline/area.ts`, the `build:area` stub from f6. It writes
  `data/propstar/area.duckdb`, beside the `propstar.duckdb` that `pipeline/build.ts` writes.
- Run `INSTALL` and `LOAD` for `spatial` and `httpfs`. Attach `propstar.duckdb` with `READ_ONLY` and
  run `SELECT id, lat, lon FROM properties`.
- Create `app/server/src/ops/area/cells.ts` with `coverCells(points, reachM = 1000)`, which
  `area.ts` imports. Per property, list every 0.02° cell that the box reaching `reachM` each way
  touches. A cell id is `${Math.floor(lon / 0.02)}_${Math.floor(lat / 0.02)}`. Return the cells
  deduplicated and sorted by id, so every run loads them in the same order.
- Read release `2026-10-21.0`, themes `transportation/segment` and `places/place`. Take the storage
  path from Overture's documentation. Do not write it from memory. Run `DESCRIBE` on one file per
  theme first and confirm the columns named below.
- Load one cell per theme per query, filtered on Overture's `bbox` column. Keep a segment only when
  its `subtype` is `road`, so rail and water never count as a street.
- Keep per segment `name` (from `names.primary`), `class` and `geom`. Keep per place `name`,
  `basic_category`, `taxonomy` and `geom`. Store `geom_utm` as `ST_Transform(geom, 'EPSG:4326',
  'EPSG:32611', always_xy := true)`, computed once here.
- A segment can cross two cells, so the Overture `id` is the key and inserts use `ON CONFLICT DO
  NOTHING`. A cell's rows and its `cells` row go in one transaction. Skip a `(cell_id, theme)`
  already in `cells`, so a stopped run resumes. Write the covered property ids to `covered`.
- Print the cell count, one line per cell and theme with rows and seconds or `skip`, the rows per
  table and the total time. Print no name.
- Create `app/server/src/ops/area/cells.test.ts` with invented points. Check that a point near a
  cell corner gets all four cells, that two points in one cell give one cell and that the order is
  stable.

## Data structures

- `segments`: `{id, name, class, geom, geom_utm}`. `name` may be null.
- `places`: `{id, name, basic_category, taxonomy, geom, geom_utm}`, with `taxonomy` as read.
- `cells`: `{cell_id, theme: 'segment' | 'place', rows, seconds}`. `covered`: `{property_id}`.
- A 2 km box took 58.1 s for segments and 11.3 s for places. Expect about a minute per cell.

## Verification

1. Run `pnpm --dir app/server typecheck` and `pnpm --dir app/server test`.
2. Run `pnpm --dir app/server build:area`. Stop it with Ctrl+C after three cells. Run it again. It
   prints `skip` for the finished cells and loads the rest.
3. Run it a third time. It skips every cell. Record the cell count, the row counts and the total
   time in `decisions-lane-c.tsv`.
4. Run the ownership check with `--lane lane-c`.

# Phase b6: Signage rules

Part of [the plan overview](overview.md).

Lane B, signage track, phase 1. It depends on [f6](phase-f6-server-scaffolds.md) and starts no
server.

## Goal

The Signage tool gets the Los Angeles base sign rules as rows a person can check, and a local
zoning table. After this phase `signAllowance` turns frontage and storeys into allowed sign sizes.

## Changes

- Create `app/server/src/ops/signage/rules.ts` with `RULES`, one `RuleRow` per base rule of LAMC
  14.4, from [findings.md](findings.md). Read each section number, the pole frontage steps and
  any storey limit on the wall bonus from the code text, with the page in `sourceUrl`. Invent no
  section. If you cannot confirm a row, write `section: null` and `checked: false`.
- Export the pure `signAllowance(rules, {streetFrontageFt, buildingFrontageFt, storeys,
  wallHeightFt})` from the same file. Wall area is `(2 * street + building) * (1 + bonus)`, with
  `bonus = Math.min(0.10 * (storeys - 1), 0.50)`, and a wall sign's top stays at or below
  `wallHeightFt`. A projecting sign needs 50 ft of street frontage, and the count is
  `Math.max(1, Math.floor(street / 200))`. A monument gets `1.5 * street`, capped at 75 sq ft.
  All signs together get `4 * street`. A limit whose row has `value: null` comes back `null`.
  `unverified` lists the id of each row it used that has `checked: false`.
- Create `cells.ts` with `cellOf(lat, lon)` and `cellBox(cell)`, for 0.02° cells by `Math.floor`.
- Fill `app/server/pipeline/zoning.ts`. For each distinct cell of the `loadProperties` points,
  request `https://data.lacity.org/resource/jjxn-vhan.json` filtered to the cell's box, paging
  with `$limit` and `$offset`. Take the geometry column and the SoQL box function from the Socrata
  docs and one `$limit=1` response. Print no coordinate.
- Write `<dataDir>/zoning.duckdb` with tables `cells` (`cell`, `row_count`) and `zones`. Skip a
  cell that `cells` holds, and write each cell in one transaction. Print the cell and row counts,
  and the 20 commonest `-` parts of `zone_cmplt`, because overlay suffixes were not checked.

## Data structures

- `RuleRow`: `{id, signType, section, sourceUrl, text, value, unit, checked}`. `signType` is
  `wall`, `projecting`, `pole`, `monument` or `all`. `unit` is `sqft_per_ft`, `percent`, `ft`,
  `in` or `sqft`. Ids read `<signType>_<limit>`, such as `wall_storey_bonus`. The pole rows are
  `pole_height_1` to `pole_height_3`, with frontage steps `pole_step_2` and `pole_step_3`.
- `Allowance`: `{wall: {areaSqFt, maxTopFt, maxProjectionIn, lotLineFt}, projecting: {allowed,
  count, minClearanceFt, maxProjectionFt, lotLineFt}, pole: {heightFt, lotLineFt}, monument:
  {areaSqFt, heightFt}, allSignsSqFt, sections, unverified}`. `sections` maps a sign type to its
  main rule's section.
- `zones`: `{cell, zone_cmplt, min_lon, min_lat, max_lon, max_lat, rings}`, one row per polygon
  part, with `rings` as JSON `[outer, ...holes]` of `[lon, lat]` points.

## Verification

1. Run `pnpm --dir app/server typecheck` and `pnpm --dir app/server test`. The tests check wall
   area at 100 ft for 1, 3, 6 and 12 storeys (300, 360, 450 and 450 sq ft), a projecting sign
   refused at 40 ft, the monument cap, unique ids, a section and `value` on each checked row, and
   a point across a cell edge.
2. Run `pnpm --dir app/server build:zoning` twice, and the second run skips every cell. Record
   the counts and the number of checked rows in `decisions-lane-b.tsv`.
3. Run the ownership check with `--lane lane-b`.

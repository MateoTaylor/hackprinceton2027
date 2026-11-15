# Phase f4: Equipment catalogue

Part of [the plan overview](overview.md).

Foundation phase 4. It depends on [f2](phase-f2-ops-http.md). It uses API port 8788.

## Goal

One table of the lifts, vehicles and props that the Scene tool places and the Signage tool
chooses from. After this phase `equipment_list` answers.

## Changes

- Create `app/server/src/model/equipment.ts` with `EQUIPMENT` and `EQUIPMENT_CLASSES`. The file
  imports no package, because the web app imports it at runtime.
- The classes are `slab_scissor`, `rough_terrain_scissor`, `articulating_boom`, `telescopic_boom`,
  `forklift`, `pallet_jack`, `wheelchair`, `prop` and `sign`.
- Fill the lift rows from the lift table in [findings.md](findings.md). Recheck every number
  against the maker's specification sheet as you write it. Store metres. Compute
  `workingHeightM` as the platform height plus 1.83 m, which is the 6 ft the makers add.
- Write `null` for a dimension you cannot confirm. `equipment_list` reports such a row with
  `placeable: false`, so the Scene tool never draws a vehicle at a guessed size.
- Give each row a generic `id`, such as `slab_scissor_19ft`, and a generic `label`. Keep the
  maker's model name in `specRef` only, as the reference for the numbers.
- Add one `forklift`, one `pallet_jack`, one `wheelchair` and three `prop` rows (a grand piano, a
  crate and a pallet). Mark their dimensions `inferred` with a `confidence`.
- The `wheelchair` row is an occupied manual chair. Fahim asked on 2026-11-15 for a wheelchair
  that the Scene tool places and drives. Keep it inside the 0.70 by 1.4 m footprint that
  [r3](phase-r3-route-solve.md) routes for its `wheelchair` payload.
- Add one `sign` row with the id `sign_panel`. It is a flat panel 2.4 m long, 0.6 m tall and
  0.05 m deep, marked `inferred`. [b5](phase-b5-surface-anchors.md) hangs it on a wall, and
  [b6](phase-b6-sign-size.md) lets a placed sign take another width and height.
- Give every row a `mount`. It is `wall` for `sign_panel` and `floor` for every other row.
- Create `app/server/src/ops/equipment/index.ts` with `equipment_list` and add it to `OPS`.
- Create `equipment.test.ts`. It checks that ids are unique, that every dimension is positive or
  `null`, that `workingHeightM` equals the platform height plus 1.83 m, that only `sign` rows
  mount on a wall, and that the full list fits under `RESULT_MAX_CHARS`.

## Data structures

- `Equipment`: `{id, class, label, specRef, platformHeightM, workingHeightM, outreachM, lengthM,
  widthM, stowedHeightM, weightKg, terrain: 'slab' | 'rough', indoor, mount: 'floor' | 'wall',
  source, confidence}`. Every dimension is a number or `null`.
- `equipment_list` input: `{class?}`.
- `equipment_list` result: `{items: [{id, class, label, workingHeightM, outreachM, widthM, lengthM,
  stowedHeightM, terrain, indoor, mount, placeable}]}`.

## Verification

1. Run `pnpm --dir app/server typecheck` and `pnpm --dir app/server test`.
2. Start the API on port 8788 and record its PID.
3. Run `node docs/plans/01-propstar-tools/probe-op.mjs equipment_list --port 8788`. The outline
   shows `items` with one entry per row of `EQUIPMENT`.
4. Run the same command with `class=nope`. It exits 1 with `invalid_input`.
5. Stop the PID you recorded. Run the ownership check with `--lane foundation`.

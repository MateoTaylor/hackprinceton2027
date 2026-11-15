# Phase b7: Lift choice

Part of [the plan overview](overview.md).

Lane B, signage track, phase 2. It depends on [f4](phase-f4-equipment.md) and uses API port 8789.

## Goal

A model asks which lift reaches a height and gets the smallest class that does, with the margin
and the next options. After this phase `lift_choose` answers, and [b8](phase-b8-signage-plan.md)
can name the lift that installs a sign.

## Changes

- Create `app/server/src/ops/signage/lift.ts` with the pure `chooseLift({heightM, outreachM,
  ground, overObstacle})` over `EQUIPMENT` from `app/server/src/model/equipment.ts`. Export
  `LIFT_CLASS_ORDER`, which is `slab_scissor`, `rough_terrain_scissor`, `articulating_boom` and
  `telescopic_boom`, smallest first. Rows of any other class are not lifts.
- A row fits when all of these hold.
  - `workingHeightM` is not `null` and is at least `heightM`.
  - Its outreach is at least `outreachM`. A `null` outreach counts as 0, as a scissor has none.
  - `ground: 'unpaved'` needs `terrain: 'rough'`, because a slab scissor needs firm paving.
  - `overObstacle: true` needs `articulating_boom`, the class that reaches up and over.
- Sort the fitting rows by class order, then by `workingHeightM`. The first is the choice and the
  next three at most are `alternatives`. A telescopic boom gives the longest outreach, so it comes
  last. `chooseLift` returns `null` when no row fits.
- Replace the `lift_choose` stub in `app/server/src/ops/signage/index.ts`. On `null` the op
  throws `no_data`, and the hint names the label and `workingHeightM` of the tallest lift.
- One assumption always reads "The permit for a lift on a public sidewalk was not researched."
  Another says working height is platform height plus 6 ft. When the caller left `ground` out, a
  third says the ground was assumed paved.
- The result names the generic `label` only. The maker's model name stays in `specRef`.
  `lift.test.ts` reads its expected rows from `EQUIPMENT`, so the tests follow the table.

## Data structures

- `LiftNeed`: `{heightM, outreachM, ground: 'paved' | 'unpaved', overObstacle}`.
- `lift_choose` input: `{heightM, outreachM = 0, ground = 'paved', overObstacle = false}`, with
  `heightM` positive and `outreachM` 0 or more.
- `lift_choose` result: `{equipmentId, class, label, workingHeightM, marginM, alternatives,
  assumptions, source: 'maker'}`. `marginM` is `workingHeightM - heightM`. An alternative is
  `{equipmentId, class, label, workingHeightM, marginM}`.

## Verification

1. Run `pnpm --dir app/server typecheck` and `pnpm --dir app/server test`. The tests check that 5
   m on paving picks a `slab_scissor`, 5 m unpaved a `rough_terrain_scissor`, 10 m over an
   obstacle an `articulating_boom`, an outreach past every articulating row a `telescopic_boom`,
   at most 3 `alternatives`, and `null` above every row.
2. Start the API on port 8789 as [testing.md](testing.md) shows, and record its PID.
3. Run `node docs/plans/01-propstar-tools/probe-op.mjs lift_choose heightM=10 --port 8789 --show
   result.class --show result.marginM`. It prints `200 ok`. Run it with `heightM=200`, which
   exits 1 with `no_data` and a hint.
4. Record the printed lines in `decisions-lane-b.tsv`, and stop the PID you recorded.
5. Run the ownership check with `--lane lane-b`.

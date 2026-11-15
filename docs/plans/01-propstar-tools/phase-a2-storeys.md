# Phase a2: Storeys

Part of [the plan overview](overview.md).

Lane A, data track, phase 2. It depends on [a1](phase-a1-shell.md). It uses API port 8788.

## Goal

The shell gains a stack of storeys with a count, a height and an outline each. After this phase
`building_get` returns empty storeys that later phases fill with spaces.

## Changes

- Create `app/server/src/ops/building/storeys.ts` with `stackStoreys(shell, facts, property)` and
  `storeyLabel(index, facts)`.
- Take the count from `facts.stories` with `source: 'costar'`. Without it, divide `shell.heightM`
  by the storey height and round down, with `source: 'inferred'` and `confidence: 0.4`.
- Take the height from `facts.slabToSlabFt` in metres. Without it, use 3.6 m for a commercial
  property and 3.0 m for a residential one, inferred at 0.4.
- Do not stretch storeys to fill the shell. On the worked example the shell is about a quarter
  taller than the storey count times the slab-to-slab height. Keep the storey count and add an
  assumption that states both numbers and calls the remainder roof plant.
  [findings.md](findings.md) lists that gap as unexplained.
- When the stack is taller than the shell, set the storey height to `shell.heightM` divided by
  the count, mark it inferred at 0.4 and add an assumption.
- A storey's `ring` is the union of every volume whose `topM` is above the storey's `elevationM`.
  Compute it with `clipper2-ts`. When the union has more than one ring, keep the ring that
  contains the primary volume. The podium then widens the low storeys of a tower.
- Settle `storeyLabel` from the data. [findings.md](findings.md) says the floor codes start at 24
  for First, and the worked example has one more code than it has storeys. Write a script in your scratchpad that opens
  `propstar.duckdb` read-only and prints each distinct `code` in `building_facts.floors` with its
  count. Print codes and counts only. Record the mapping you choose in `decisions-lane-a.tsv`.
  A storey with no code gets the label `Floor <index + 1>`.
- Compare each ring's area with the `sizeSf` of its code. When they differ by more than 25%, add
  one assumption that says so. Do not change the ring.
- Each storey starts with empty `spaces`, `openings` and `furnishings`.
- Create `storeys.test.ts` with an invented tower on a podium. Test the count, the height, the
  wider low storeys, both defaults without facts and that `checkBuilding` reports no problem.

## Data structures

- `stackStoreys` returns `{storeys, assumptions}`.
- `STOREY_HEIGHT_DEFAULT_M`: `{commercial: 3.6, residential: 3.0}`.

## Verification

1. Run `pnpm --dir app/server typecheck` and `pnpm --dir app/server test`.
2. Start the API on port 8788 and record its PID.
3. Run `node docs/plans/01-propstar-tools/probe-op.mjs building_get propertyId=commercial-248243
   --port 8788 --show result.counts.storeys`. It prints `200 ok` and 12.
4. Run it with `--detail --show detail.building.storeys.0.heightM`. The value is near 3.66.
5. Stop the PID you recorded. Run the ownership check with `--lane lane-a`.

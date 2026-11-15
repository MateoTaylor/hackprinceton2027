# Phase a4: Scan placement

Part of [the plan overview](overview.md).

Lane A, data track, phase 4. It depends on [a2](phase-a2-storeys.md) and
[a3](phase-a3-scan-plan.md). It uses API port 8788.

## Goal

Each scan lands on a storey at a position and a rotation, with a confidence that says how well it
fits. After this phase `building_get` holds real rooms and doors wherever a scan exists.

## Changes

- Create `app/server/src/ops/building/placement.ts` with `placeScan(scanPlan, scan, storeys)`.
- Pick the storey from the suite number in the scan's name. Suite 1000 goes to the tenth storey
  at confidence 0.5, because [findings.md](findings.md) lists that reading as unverified. A name
  with no number goes to the ground storey at 0.3. Add an assumption either way.
- Fit the scan floor's outline to the storey ring. Align the longest edges, move centroid onto
  centroid and try the four rotations 90° apart. Score each with intersection over union from
  `clipper2-ts`.
- A best score of 0.6 or more gives `fit: 'outline'`. Set `flipAmbiguous` when the best rotation
  and the one 180° from it score within 0.02 of each other, and add an assumption.
- Below 0.6 the scan is a suite smaller than the storey. Keep the rotation that puts the largest
  share of the outline inside the ring. With 95% or more inside, the scan gets `fit: 'inferred'`
  at confidence 0.2. Otherwise it goes to `unplacedScans` with a reason.
- The scan's `confidence` is the lower of its score and its storey confidence.
- `transform` rotates a point by `yawDeg` counter-clockwise about the scan's origin and then adds
  `tx` and `ty`. Apply it to every space ring and opening. Clip space rings to the storey ring.
  Write them into the storey with `source: 'scan'` and the scan's confidence.
- A scan whose spaces overlap an already placed scan by more than 10% goes to `unplacedScans`.
- A scan with several floors maps them to consecutive storeys by `sequence` and uses one
  transform, taken from its largest floor. `Staircase` spaces that overlap in plan across two of
  its floors become one `stair` connector with a landing on each storey.
- Add the step to `building_get`. One failed scan must not fail the op.
- Create `placement.test.ts` from `FIXTURES.officeTower`. Move and rotate a storey ring by a
  known transform and check that `placeScan` recovers it within 0.1 m and 1°. Check
  `flipAmbiguous` on a rectangle and on an L shape, the small suite and the scan that fits nowhere.

## Data structures

- `placeScan` returns `{kind: 'placed', scan, spaces, openings, connectors, assumptions}` or
  `{kind: 'unplaced', modelId, name, reason}`. `spaces` and `openings` are keyed by storey index.

## Verification

1. Run `pnpm --dir app/server typecheck` and `pnpm --dir app/server test`.
2. Start the API on port 8788 and record its PID.
3. Run `node docs/plans/01-propstar-tools/probe-op.mjs building_get propertyId=commercial-248243
   --port 8788 --detail --show result.counts.scans --show detail.building.scans.0.iou --show
   detail.building.scans.0.flipAmbiguous`. The scan count is 1 or more and the score is over 0.6.
4. Record the printed lines in `decisions-lane-a.tsv`.
5. Stop the PID you recorded. Run the ownership check with `--lane lane-a`.

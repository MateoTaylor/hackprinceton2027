# Phase c5: Detect probe (optional)

Part of [the plan overview](overview.md).

Lane C, features track, phase 2. It depends on [c4](phase-c4-features-ops.md). It uses API port
8790 to list the properties. If time runs short, the overview cuts this phase second, after r5.

## Goal

The main session learns whether Vexcel's `elements/detect` gives anything worth an op, from at
most three calls that cost nothing. After this phase `decisions-lane-c.tsv` holds the billing
answer and at most three rows of status and detection count.

## Changes

- Nothing in this repo spends money. Before any call, read Vexcel's API documentation for
  `elements/detect` and find whether it is billed per call or counts against a paid quota. Record
  the answer and the page title in `decisions-lane-c.tsv`.
- If it is billed, or the documentation does not say, stop and report to the main session. Make
  no call.
- Take the request shape from the same documentation. Do not write a parameter or field from
  memory. The one sample in [findings.md](findings.md) answered 200 with zero detections.
- Start the API on port 8790 and record its PID. Run `node -e
  "fetch('http://127.0.0.1:8790/api/properties').then(r => r.json()).then(b => b.forEach(p =>
  console.log(p.id, p.typeLabel)))"`. If the response wraps the list, adjust the path. Print the
  id and type label only. Choose one office, one industrial and one multifamily property. Stop
  the PID you recorded.
- Create `app/server/src/ops/features/detect.live.test.ts`. It skips without `VEXCEL_API_KEY`,
  so `pnpm test` never runs it. It reads `lat` and `lon` of the three ids from `propstar.duckdb`,
  opened read-only.
- It makes one request per property, three in all, one after another. The key goes in the
  `X-API-KEY` header, as in `vexcel.ts`, never in the URL. A 429 ends the run with no retry.
- It prints one line per call with the property id, the HTTP status and the detection count. It
  prints no body, detection, image or header.
- The test uses its own `fetch`, because `vexcel.ts` has no detect method and lane C does not
  edit it. If the op is wanted later, the call moves into `vexcel.ts` through foundation and this
  test is deleted.
- If all three calls return zero detections, record that and close the phase. If any returns a
  detection, stop and report the three lines to the main session, which decides whether
  `features_detect` joins the ops. Do not add the op in this phase.

## Data structures

- A decision row per call: `{propertyId, typeLabel, status, detectionCount}`.
- The test file holds no fixture, no response and no coordinate.

## Verification

1. Run `pnpm --dir app/server typecheck` and `pnpm --dir app/server test`. The live test reports
   as skipped.
2. If the billing answer allows it, run `node --env-file=../../.env --test
   src/ops/features/detect.live.test.ts` from `app/server`. It prints three lines.
3. Record those three lines in `decisions-lane-c.tsv` and nothing else from the run.
4. Run `git grep -n "elements/detect" -- app/`. The only match is the live test.
5. Run the ownership check with `--lane lane-c`.

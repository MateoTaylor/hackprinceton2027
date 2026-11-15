# Phase r2: Door fit

Part of [the plan overview](overview.md).

Lane A, routing track, phase 2. It depends on [r1](phase-r1-storey-grid.md) and
[f3](phase-f3-building-model.md) and starts no server.

## Goal

Every door gets a verdict and a confidence for a given payload. After this phase
[r3](phase-r3-route-solve.md) can price each door it crosses and tell the user which dimension
stops the payload.

## Changes

- Create `app/server/src/ops/route/doorFit.ts` with `doorFit(opening, payload)`,
  `fitConfidence(clearanceM, freeFraction)` and the constants `PASS_CONFIDENCE = 0.5`,
  `FIT_CAP = 0.8` and `DEFAULT_DOOR_HEIGHT_M = 2.03`.
- Width clearance is the opening's `widthM` minus the payload's `widthM`. Height clearance is the
  opening's `heightM` minus the payload's `heightM`. `clearanceM` is the smaller of the two, and
  `limitedBy` is `'width'` or `'height'` after the one that is smaller. On a tie, use `'width'`.
- If the opening's `heightM` is `null`, use `DEFAULT_DOOR_HEIGHT_M`, which is a common 80 in door.
  [r3](phase-r3-route-solve.md) states this in its assumptions when it happens.
- `fitConfidence` returns `sigmoid((clearanceM - 0.05) / 0.03) * freeFraction`, capped at
  `FIT_CAP`. The cap holds because the API says nothing about the door leaf or its swing.
  `freeFraction` is 1 until [r5](phase-r5-mesh-clearance.md) measures it.
- `verdict` is `pass` when the fit confidence is at or above `PASS_CONFIDENCE`, else `fail`.
- If the opening's `source` is `inferred`, multiply the fit confidence by the opening's own
  `confidence` to get the reported `confidence`. Take the verdict before this step. A gap-filled
  door carries a confidence of 0.3 at most, so a verdict taken after it would fail every inferred
  door. The tick or cross then says whether the payload fits, and the colour says how sure we are.
- `source` on the `DoorFit` is the opening's `source`. [r5](phase-r5-mesh-clearance.md) sets it
  to `mesh` when the width comes from the scan mesh. Round `clearanceM` and `confidence` to 0.01.
- `doorFit` is pure. It reads no file and calls no op. Declare `Payload` and `DoorFit` in this
  file. [r3](phase-r3-route-solve.md) imports both.
- Create `doorFit.test.ts` with invented numbers.
  - A 1.2 m by 2.1 m door and a 0.70 by 1.4 m payload pass, with a confidence of exactly 0.8.
  - A door 2 cm narrower than the payload fails, and its confidence is under 0.1.
  - `fitConfidence(1, 1)` returns 0.8, which shows the cap holds.
  - A 1.2 m wide door 1.8 m high and a 0.55 by 1.9 m payload fail with `limitedBy: 'height'`.
  - An inferred 1.2 m door with confidence 0.3 passes with a confidence of 0.24.
  - A door with `heightM: null` uses 2.03 m.

## Data structures

- `Payload`: `{widthM, heightM, wheeled}`. `wheeled` tells r3 that stairs are closed to it.
- `DoorFit`: `{openingId, verdict: 'pass' | 'fail', clearanceM, confidence, limitedBy: 'width' |
  'height', source}`. `clearanceM` is negative when the payload is larger than the door.

## Verification

1. Run `pnpm --dir app/server typecheck` and `pnpm --dir app/server test`.
2. Record `PASS_CONFIDENCE`, `FIT_CAP` and the rule that the verdict comes before the inferred
   multiplier in `decisions-lane-a.tsv`.
3. Run the ownership check with `--lane lane-a`.

# Phase b8: `signage_measure`

Part of [the plan overview](overview.md).

Lane B, signage track, phase 3, on API port 8789. It depends on [b6](phase-b6-sign-size.md) and
[b7](phase-b7-lift-choice.md).

## Goal

A model asks about a sign it placed and gets the sign's width and height, its height above the
ground and the lift that reaches it. After this phase `signage_measure` answers for any sign in a
scene. The op checks no sign rule, zone or permit.

## Changes

- Create `app/server/src/ops/signage/measure.ts` with the pure `measureSign(object)`.
  - `bottomAboveGroundM` is `position[1] - heightM / 2 - groundY`. `topAboveGroundM` adds
    `heightM`. `areaM2` is `widthM * heightM`. Round each to 0.01.
  - Without `groundY`, both heights are `null`.
  - A bottom more than 0.05 m below the ground means the ground hit was wrong. Both heights are
    then `null`, and `groundProblem` is `true`.
- Replace the `signage_measure` stub in `app/server/src/ops/signage/index.ts`. The effect is
  `read`.
  - Read the scene with `readScene` from `../scene/document.ts`, which lane B owns.
  - An unknown `objectId` throws `not_found`, and the hint names `scene_get`.
  - An object whose row is not class `sign` throws `invalid_input`. The hint reads "Place a
    sign_panel with scene_place first."
- Choose the lift through `ctx.call('lift_choose', {heightM: topAboveGroundM})`.
  - With `topAboveGroundM` at 2 m or less, make no call. `lift` is `null`, and an assumption says
    a person reaches the sign from the ground.
  - On `no_data`, `lift` is `null` and an assumption says no lift in the catalogue reaches that
    height.
  - With a `null` height, `lift` is `null`.
- `assumptions` always holds "The sign is a blank placeholder. No sign rule, zone or permit was
  checked." Add the assumptions that `lift_choose` returned.
  - Without `groundY`, add "The ground under this sign is not measured yet. Open the space in the
    Signage panel, or send groundY with scene_move."
  - With `groundProblem`, add "The measured ground is above the sign's bottom edge, so the heights
    are left out."

## Data structures

- Input: `{spaceId, objectId}`.
- Result: `{spaceId, objectId, widthM, heightM, areaM2, bottomAboveGroundM | null,
  topAboveGroundM | null, lift, source: 'mesh', assumptions}`. `source` is `mesh` because the
  ground level comes from the scan mesh.
- `lift`: `{equipmentId, class, label, workingHeightM, marginM} | null`, taken from the
  `lift_choose` result without its alternatives.

## Verification

1. Run `pnpm --dir app/server typecheck` and `pnpm --dir app/server test`. On invented objects,
   `measure.test.ts` checks a 3 by 1 m sign at `y = 3` over `groundY = 0` (bottom 2.5, top 3.5,
   area 3), a sign without `groundY`, and a ground above the bottom edge. `signage.test.ts` checks
   `not_found`, a forklift giving `invalid_input`, and a low sign giving no lift.
2. Start the API on port 8789 and record its PID.
3. Place a test sign. Run `node docs/plans/01-propstar-tools/probe-op.mjs scene_place
   spaceId=L3sdz2m7jxp equipmentId=sign_panel position=[0,3,0] anchor.kind=wall
   anchor.normal=[1,0,0] sizeM.widthM=3 sizeM.heightM=1 groundY=0 --port 8789 --show
   result.version`. Then run `scene_get` with `--show result.objects.0.id` and find your sign's id.
4. Run `signage_measure spaceId=L3sdz2m7jxp objectId=<id> --show result.topAboveGroundM --show
   result.lift.class`. It prints `200 ok`, 3.5 and a class. Run it with `objectId=o-nope`, which
   exits 1 with `not_found`.
5. Remove the test sign with `scene_remove`. Record the printed lines in `decisions-lane-b.tsv`.
6. Stop the PID you recorded. Run the ownership check with `--lane lane-b`.

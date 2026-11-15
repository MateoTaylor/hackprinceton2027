# Phase b9: Signage panel

Part of [the plan overview](overview.md).

Lane B, signage track, phase 4, and a milestone. It depends on [b8](phase-b8-signage-plan.md) and
[l5](phase-l5-dollhouse-panel.md). It uses API port 8789 and web port 5175. Read
`docs/design/design.md` and run the **frontend-design** skill first.

## Goal

A user opens Signage from the property card and sees the blank sign on the building, its size,
the lift that installs it and what the rules allow. After this phase the signage track is ready
for review.

## Changes

- Create `app/web/src/signage/Elevation.tsx` with `Elevation({facade, sign})`. It draws the facade
  as a flat SVG elevation scaled to its box, in `--surface-2` with a `--border` outline. Draw the
  blank sign centred at `mountHeightM`, as b8 placed it, with an `--accent-bright` outline. Label
  its width, its height and the mounting height above the ground line, in metres to one decimal
  with feet beside them.
- Create `app/web/src/signage/signLayer.ts` with `signLayer(corners)`. It returns a `StageLayer`
  with `id: 'sign'` and no `onStorey`. Its `object` is a two-triangle quad through the corners
  plus an `EdgesGeometry` outline, both in `DEFAULT_LOOK.palette.accent`. Map each corner with
  `toScene`. Import from `app/web/src/dollhouse/index.ts` only.
- Fill `app/web/src/signage/SignagePanel.tsx`. Call `useOp('signage_plan', {propertyId:
  property.id}, {detail: true})` and `useOp('building_get', {propertyId: property.id}, {detail:
  true})`.
  - At the top, draw `Dollhouse` with `detail.building`, `storeyIndex: null` and `layers:
    [signLayer(detail.corners)]`. When `corners` is `null`, pass no layers. Draw `Elevation` below.
  - Show the zone, then one row per sign type in `allowed` with its area or height and its
    section. Mark a row with `checked: false` as "Unconfirmed", and show a `null` section as
    "Section not confirmed".
  - Show the lift's class label and working height, or "No lift drawn" when `lift` is `null`.
  - List `assumptions`. Show "Subject to overlays" as its own line, always.
- The loading and error states come from `ToolPanel`. A `no_data` answer shows its hint. Keep
  the CSS in `app/web/src/signage/signage.css` and import it from the panel.
- Create `signLayer.test.ts`. It checks that the layer has no `onStorey` and that the quad's 4
  vertices sit at the mapped corners.

## Data structures

- `ElevationProps`: `{facade: {lengthM, heightM}, sign: {widthM, heightM, mountHeightM} | null}`.
- `SignPlan` and `SignDetail`: the `signage_plan` result and detail from b8, declared in
  `app/web/src/signage/types.ts`. The web has no `zod`, and `callOp` trusts the named type.

## Verification

1. Run `pnpm --dir app/web typecheck` and `pnpm --dir app/web test`.
2. Start the API on port 8789 and the web app on port 5175. Record both PIDs.
3. Open `http://localhost:5175`, select `commercial-248243` and open Signage. Take a screenshot
   at 1440 by 900, save it to your scratchpad and check it against `docs/design/design.md`. The
   sign shows on the building and on the elevation, and "Subject to overlays" is visible.
4. Stop both PIDs. Run the ownership check with `--lane lane-b`.
5. Stop here. The main session hands the signage diff to a reviewer subagent.

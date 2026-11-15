# Phase l5: Dollhouse panel

Part of [the plan overview](overview.md).

Lane A, look track, phase 5. It depends on [l4](phase-l4-inferred-style.md) and
[a7](phase-a7-building-op.md). It uses API port 8788 and web port 5174.

## Goal

The Dollhouse panel draws a real property. After this phase a user opens the panel from the
property card and steps through the storeys of three building types, and other panels can draw
into the same view.

## Changes

- Create `app/web/src/dollhouse/Dollhouse.tsx`. Its props are `{building, look?, storeyIndex,
  layers?, onPick?, onHover?}`. It creates the stage in an effect, feeds it `buildCutaway` plus
  the caller's `layers`, and calls `dispose` on unmount.
- `layers` is how the route overlay and the sign layer draw into the dollhouse. They pass
  `StageLayer` objects and never reach into the stage.
- Create `app/web/src/dollhouse/index.ts`. It exports `Dollhouse`, `toScene`, `DEFAULT_LOOK` and
  the types `StageLayer`, `Pick` and `Look`. Other folders import from this file only.
- Fill `DollhousePanel.tsx`. Call `useOp('building_get', {propertyId: property.id}, {detail:
  true})` and draw `detail.building`. Show a storey picker that marks scanned storeys, the legend,
  the assumptions from `result.assumptions` and the number of unplaced scans.
- Open on the lowest storey that holds scanned space. Without one, open on the ground storey.
- The loading and error states come from `ToolPanel`. A `no_data` answer shows its hint.
- Fit the camera to the shell and to the context within 150 m. A tower and a warehouse then both
  fill the panel.
- Keep the panel's CSS in `dollhouse/dollhouse.css`.

## Data structures

- `DollhouseProps`: `{building: BuildingModel, look?: Look, storeyIndex: number | null, layers?:
  StageLayer[], onPick?: (pick: Pick) => void, onHover?: (pick: Pick | null) => void}`.
- `BuildingModel` comes from `app/server/src/model/building.ts` through `import type`.

## Verification

1. Run `pnpm --dir app/web typecheck` and `pnpm --dir app/web test`.
2. Start the API on port 8788 and the web app on port 5174. Record both PIDs.
3. Open the Dollhouse panel for each of the three property ids that a7 recorded in
   `decisions-lane-a.tsv`. Take one screenshot of each at 1440 by 900, save them to your
   scratchpad and check them against `docs/design/design.md`.
4. Count the canvases with `document.querySelectorAll('canvas').length` in the page. Open and
   close the panel five times and count again. The two counts match, which shows that `dispose`
   works.
5. Stop both PIDs. Run the ownership check with `--lane lane-a`.
6. Stop here. The main session hands the look track's diff to a reviewer subagent and shows
   Fahim the three screenshots.

# Phase b9: Signage panel

Part of [the plan overview](overview.md).

Lane B, signage track, phase 4, and a milestone. It depends on [b8](phase-b8-signage-measure.md).
It uses API port 8789 and web port 5175. Read `docs/design/design.md` and run the
**frontend-design** skill first.

## Goal

A user opens Signage, sees a building from outside in its Matterport scan, clicks the wall to
hang a blank sign and switches on measurement lines. The lines show the sign's width, its height
and its height above the ground. After this phase the signage track is ready for review.

## Changes

- Create `app/web/src/scene/signMeasure.ts` with the pure `signMeasures(sign)` and
  `formatLength(m)`.
  - `signMeasures` returns up to three `Measure` entries. `width` runs along the top edge, 0.15 m
    above it. `height` runs along one side edge, 0.15 m beside it. `clearance` runs from the
    bottom centre straight down to `groundY`. Without `groundY` it returns no `clearance`.
  - Every point sits 0.02 m in front of the sign's face, along `anchor.normal`. The width axis is
    the horizontal direction at right angles to the normal.
  - `formatLength(2.4)` returns `2.40 m · 7 ft 10 in`. Round to the nearest inch, and carry 12
    inches into a foot.
- Create `app/web/src/scene/measureOverlay.ts` with `createMeasureOverlay(handle)`. It draws each
  measure the way Matterport's own measurement mode does: a white line, a dot at each end and a
  label at the midpoint.
  - Build every object with `handle.three`. The line is a thin cylinder of 0.012 m radius,
    because WebGL lines are one pixel wide. The dots are spheres.
  - The label is a `Sprite` with a `CanvasTexture`: a dark pill with white text from
    `formatLength`. Use `sizeAttenuation: false`, so the label keeps its size on screen.
  - Every material has `depthTest: false` and a high `renderOrder`, so the scan never hides a
    line.
- In `ScenePanel.tsx`, add the props `initialSpaceId` and `renderTools(ctx)`. The panel opens
  `initialSpaceId` first and draws what `renderTools` returns under its object list.
- Fill `app/web/src/signage/SignagePanel.tsx`. It renders `ScenePanel` with `initialSpaceId:
  EXTERIOR_SPACE_ID` and these controls.
  - **Place sign** arms `sign_panel` for a wall click, through the flow in
    [b5](phase-b5-surface-anchors.md).
  - Width and height inputs in metres, in steps of 0.1. A change calls `sync.resize` after 300 ms.
  - A **Measurements** switch. It shows the overlay for the selected sign and starts on.
  - A readout from `signage_measure`, called again after each scene change: width, height, area,
    bottom and top above the ground, and the lift's label and working height. A `null` height
    reads "Ground not found".
  - **Place lift** arms the chosen lift for a floor click below the sign. Cut this button first if
    time runs short.
- Keep the CSS in `app/web/src/signage/signage.css`. Controls use the tokens in `design.md`.

## Data structures

- `Measure`: `{id: 'width' | 'height' | 'clearance', a: [x, y, z], b: [x, y, z], lengthM}`.
- `SceneToolsContext`: `{handle, spaceId, objects, selectedId, select(id), arm(equipmentId),
  sync}`. `sync` is the `SceneSync` from [b4](phase-b4-vehicles.md).
- `MeasureOverlay`: `{show(measures), hide(), dispose()}`.

## Verification

1. Run `pnpm --dir app/web typecheck` and `pnpm --dir app/web test`. `signMeasure.test.ts` checks
   a 2.4 by 0.6 m sign at `y = 4` over `groundY = 0.5` that faces +X (lengths 2.4, 0.6 and 3.2),
   the same sign without `groundY` (two measures), and `formatLength` on 2.4, 0.3 and 3.05.
2. Start the API on port 8789 and the web app on port 5175. Record both PIDs.
3. Open `http://localhost:5175`, select a property and open Signage. Hang a sign on the outside
   wall and set it to 3 by 1 m. Use `browser_take_screenshot` only, at 1440 by 900.
4. Take one screenshot with Measurements on and one with it off. With it on, three labelled
   lines show, and the readout names a lift. Check both against `docs/design/design.md`.
5. Stop both PIDs. Run the ownership check with `--lane lane-b`.
6. Stop here. The main session hands the signage diff to a reviewer subagent.

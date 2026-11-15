# Phase r4: Route overlay

Part of [the plan overview](overview.md).

Lane A, routing track, phase 4. It depends on [r3](phase-r3-route-solve.md) and
[l5](phase-l5-dollhouse-panel.md). It uses API port 8788 and web port 5174. Read
`docs/design/design.md` and run the **frontend-design** skill first.

## Goal

The user clicks a space, picks a payload and watches a dot trail run from the entrance, with a
tick or a cross on each door. After this phase the Routing panel answers the demo question.

## Changes

- Create `app/web/src/route/overlay.ts` with `routeLayer(detail, look, storeyIndex, elevationM)`,
  `resampleTrail(trail, storeyIndex, stepM = 0.5)` and `confidenceBand(confidence)`. Import
  `StageLayer`, `Look` and `toScene` from `app/web/src/dollhouse/index.ts` only.
- `routeLayer` returns two `StageLayer` objects with `onStorey: storeyIndex`. The trail is one
  `InstancedMesh` of 0.08 m spheres every 0.5 m, at `elevationM + 0.15`. The panel reads
  `elevationM` from `building.storeys`, because `RouteDetail` carries no elevation.
- Each door on the storey gets a 0.6 m `Sprite` at `elevationM + look.wallStubM + 0.4` with
  `depthTest: false`. Its map is a tick for `pass` or a cross for `fail`, drawn into two shared
  64 px `CanvasTexture` objects on first use, so the overlay ships no image file and the tests
  run without `document`.
- `confidenceBand` is `good` at 0.6 and above, `mid` from 0.3 and `bad` under 0.3. Copy the hex
  values of `--score-good`, `--score-mid` and `--score-bad` into `CONFIDENCE_BANDS`. A sprite
  takes its door's band and the trail takes the band of the route's `confidence`.
- Fill `app/web/src/route/RoutePanel.tsx`. Draw `<Dollhouse>` from `useOp('building_get',
  {propertyId}, {detail: true})`. Mount a child `RouteResult` once a target exists, so
  `useOp('route_solve', input, {detail: true})` runs only then and again on each change.
- `onPick` sets the target, `{spaceId}` when the pick has one, else `{at}` with its
  `storeyIndex`. A select lists the presets, `wheelchair` first. Show `lengthM`, `doorCount`,
  `failCount` and the assumptions. `reachable: false` shows "No way in for this payload".
- The storey picker marks the storeys the trail visits. A new route opens its first storey, and
  "Next storey on route" steps through the rest in trail order.
- When an `onHover` point lies within 0.6 m of a door on show, a tooltip at the pointer shows the
  door's `confidence` to two places and its `limitedBy`.
- If `setLayers` in `stage.ts` does not free replaced layers, dispose the old trail geometry in
  the cleanup of `RouteResult`. Keep the CSS in `app/web/src/route/route.css`.
- In `overlay.test.ts`, a 10 m straight trail gives 21 points, points on other storeys drop out,
  and `confidenceBand` gives `bad`, `mid`, `mid`, `good` for 0.29, 0.3, 0.59 and 0.6.

## Data structures

- `ConfidenceBand`: `'good' | 'mid' | 'bad'`. `CONFIDENCE_BANDS` maps each band to a hex colour.
- `RouteTarget`: `{spaceId} | {at, storeyIndex}`. `RouteDetail` comes from r3 by `import type`.

## Verification

1. Run `pnpm --dir app/web typecheck` and `pnpm --dir app/web test`.
2. Start the API on port 8788 and the web app on port 5174. Record both PIDs.
3. Open Routing for `commercial-248243` and route to a space on the scanned storey with
   `wheelchair`, then `grand_piano` with a door tooltip open. Screenshot each at 1440 by 900 to
   your scratchpad and check them against `docs/design/design.md`.
4. Count `document.querySelectorAll('canvas').length`, open and close the panel five times and
   count again. The counts match. Stop both PIDs. Run the ownership check with `--lane lane-a`.
5. Stop here. The main session hands the routing diff to a reviewer subagent.

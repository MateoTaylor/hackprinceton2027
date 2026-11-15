# Phase c3: Basemap and places

Part of [the plan overview](overview.md).

Lane C, area track, phase 3. It depends on [c2](phase-c2-area-ops.md). It uses API port 8790 and
web port 5176. Run the **how** skill on `app/web/src/MapView.tsx` first, and read
`docs/design/design.md`. Lane C alone edits `MapView.tsx`.

## Goal

The user opens the Area panel and sees what surrounds the building, on the map and in a list.
After this phase the map can switch to a street basemap, with the nearby places drawn on it.

## Changes

- The how run finds which sources and layers `attachObliqueRig` adds. The map stays visible on
  the left of an open tool panel, because [f7](phase-f7-web-scaffolds.md) docks the panel on the
  right.
- Add a Streets toggle cell to the map controls, with the lucide `Map` icon and the label "Street
  map". The active cell inverts to `--text` fill. Take the style URL for `STREET_STYLE_URL` from
  OpenFreeMap's own documentation. Do not write it from memory.
- Swap with `map.setStyle(next, {transformStyle})`, which carries `area-places` and the rig's
  sources and layers across. Off sets `STYLE` again. The oblique photo works in both styles.
- While Streets is on, show a `maplibregl.AttributionControl` with the OpenFreeMap and OpenStreetMap
  credit that OpenFreeMap asks for. Add no parameter or header to its requests.
- Create `app/web/src/area/areaStore.ts` with `setAreaMap`, `setActiveGroup` and `useAreaMap()` on
  `useSyncExternalStore`. `MapView.tsx` reads it into a GeoJSON source `area-places` with one circle
  layer of that id and a `--surface` stroke. The active group draws in `--text` at radius 6 and the
  rest in `--text-muted` at radius 4. With no active group, all draw in `--text` at radius 4. Read
  the tokens with `getComputedStyle` once. Add no token.
- Fill `app/web/src/area/AreaPanel.tsx`. Call `useOp('area_places', {propertyId, limit: 25},
  {detail: true})` and `useOp('area_summary', {propertyId})`. Pass `detail.places` to `setAreaMap`,
  and call `setAreaMap(null)` on unmount.
- The panel shows the fronting street and its distance, one chip per group with its count, the
  nearest of each group and the list of `result.places`. A chip sets the active group, which filters
  the list and highlights the map. A zero count is a muted chip that cannot be picked. The
  assumptions sit at the foot in caption type. The CSS lives in `app/web/src/area/area.css`.
- If Fahim takes open choice 4, "no street basemap", drop the toggle, `STREET_STYLE_URL`, the style
  swap, the attribution and Verification steps 3 and 4. Places then draw over Vexcel.

## Data structures

- `AreaMapState`: `{propertyId, places: AreaPlacePoint[], activeGroup: AreaGroup | null}`.
- `AreaPlacePoint` and `AreaGroup` come by `import type` from `app/server/src/ops/area/`.

## Verification

1. Run `pnpm --dir app/web typecheck` and `pnpm --dir app/web test`. Start the API on port 8790 and
   the web app on port 5176. Record both PIDs.
2. Open the Area panel for `commercial-248243`. Take screenshots at 1440 by 900 with no chip and
   with `food` active. Save them to your scratchpad and check them against `docs/design/design.md`.
3. Turn Streets on and take a screenshot. The attribution names OpenFreeMap and OpenStreetMap.
4. List the network requests. Every host but `localhost` is OpenFreeMap's, and no URL holds a
   property id. Record hosts and counts, not URLs.
5. Close the panel. The places layer empties. Stop both PIDs.
6. Run the ownership check with `--lane lane-c`.

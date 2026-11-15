# Phase f3: Building model

Part of [the plan overview](overview.md).

Foundation phase 3. It depends on [f1](phase-f1-op-contract.md) and starts no server. Run the
**architect** skill on it with f1. Run **interrogate** on `Op` and `BuildingModel` together before
any lane starts, because every lane reads these two types.

## Goal

One description of a building that the dollhouse draws, the router walks and the sign planner
measures. After this phase the look track can draw three invented buildings with no server.

## Changes

- Create `app/server/src/model/building.ts` with the Zod schemas `BuildingModel` and
  `BuildingDetail`, their inferred types and `checkBuilding`.
- The frame is local east, north, up in metres. The origin is `origin.lat` and `origin.lon` at
  `origin.groundElevationM`. A ring is a list of `[x, y]` points, counter-clockwise, with the first
  point not repeated. `bearingDeg` runs clockwise from north. Storey `index` 0 is the ground storey.
- `checkBuilding(building)` returns a list of problems as sentences. It checks that ids are unique,
  that every `spaceId`, `openingId` and `storeyIndex` resolves, that every ring has at least three
  points and a positive area, that each space ring lies inside its storey ring within 0.05 m, that
  storeys stack without gaps, and that every `inferred` value carries a `confidence`.
- Create `app/server/src/model/geo.ts` with `toEnu`, `toLatLon`, `ringArea`, `ringCentroid`,
  `ringBounds`, `orientCcw`, `pointInRing`, `bearingDeg` and `distanceM`. `toEnu` uses a flat
  projection about the origin, which is accurate to centimetres within 1 km.
- Create `app/server/src/model/furnishings.ts` with `FURNISHING_KINDS` and
  `FURNISHING_FOOTPRINTS`. The kinds are `desk`, `chair`, `table`, `conference_table`, `sofa`,
  `bed`, `shelf`, `counter`, `toilet`, `sink`, `plant`, `rack`, `pallet`, `crate` and `machine`.
- Create `app/server/src/model/fixtures.ts` with `FIXTURES`, three invented buildings that pass
  `checkBuilding`. Invent every number. Do not copy a measured footprint.
  - `officeTower`: 12 storeys on a 40 by 24 m plate with a podium, one storey marked as scanned.
  - `warehouse`: one storey of 60 by 36 m with dock doors, an office strip and racking.
  - `apartment`: 3 storeys with four units per storey, one unit marked as scanned.
- `fixtures.ts`, `furnishings.ts` and `geo.ts` import no package. The web app imports them at
  runtime and has no `zod`. They take their types from `building.ts` with `import type`.
- Create `building.test.ts` and `geo.test.ts` beside them.

## Data structures

- `BuildingModel`: `{propertyId, origin, shell, context, storeys, connectors, scans, assumptions}`.
- `shell`: `{heightM, volumes: [{id, ring, baseM, topM, primary, source}]}`.
- `context`: `[{ring, heightM}]`, the neighbours that the dollhouse draws in grey.
- `storeys[]`: `{index, label, elevationM, heightM, ring, source, confidence, spaces, openings,
  furnishings}`.
- `spaces[]`: `{id, label, ring, source, confidence}`.
- `openings[]`: `{id, kind: 'door' | 'opening' | 'exterior_door', at, widthM, heightM | null,
  bearingDeg, spaceIds, source, confidence}`. `spaceIds` holds two ids, or one id and `null` for an
  exterior door.
- `furnishings[]`: `{id, kind, spaceId, at, yawDeg, source, confidence}`.
- `connectors[]`: `{id, kind: 'stair' | 'elevator', landings: [{storeyIndex, at, openingId |
  null}], source, confidence}`.
- `scans[]`: `{modelId, name, storeyIndexes, transform: {tx, ty, yawDeg}, fit: 'outline' |
  'inferred', iou, flipAmbiguous, confidence}`.
- `BuildingDetail`: `{building, unplacedScans: [{modelId, name, reason}]}`.

## Verification

1. Run `pnpm --dir app/server typecheck` and `pnpm --dir app/server test`.
2. `checkBuilding` returns no problem for each of the three fixtures.
3. For each rule in `checkBuilding`, a test breaks one fixture and gets the matching problem.
4. `toLatLon(toEnu(p))` returns `p` within 0.01 m at 500 m from the origin.
5. Run the ownership check with `--lane foundation`.

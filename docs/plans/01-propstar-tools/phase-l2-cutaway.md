# Phase l2: Cut-away

Part of [the plan overview](overview.md).

Lane A, look track, phase 2. It depends on [l1](phase-l1-look-page.md). It uses web port 5174.

## Goal

One storey opens to view. The storeys above it disappear, its walls drop to stubs and each room
takes the colour of its use, so rooms and doors read at a glance. After this phase the look page
has a storey picker on every fixture.

## Changes

- Create `app/web/src/dollhouse/floorTone.ts` with the pure `floorTone(label)`. It lower-cases
  the label and returns the first `FloorTone` whose keyword the label contains, in the order of
  `FLOOR_KEYWORDS`. Without a match it returns `other`.
- Create `storey.ts` with `wallSegments(ring, openings)` and `buildStorey(storey, look)`.
- `wallSegments` is pure. It walks each edge of a ring and leaves a gap of `widthM`, centred on
  `at`, for every opening that lies within 0.05 m of the edge. It returns `[{a, b}]`.
- `buildStorey` draws one floor slab per space in `look.palette.floors[floorTone(space.label)]`,
  with a flat `MeshStandardMaterial` and no texture. It draws wall stubs `look.wallStubM` tall
  along the storey ring and along every space ring, with faces in `palette.wall` and a cap in
  `palette.cut`, and a flat sill across each opening. Two spaces share a wall, so round segment
  ends to 0.01 m and draw each segment once.
- Give every floor slab `userData.spaceId`, so a pick can name the space.
- Create `cutaway.ts` with `buildCutaway(building, storeyIndex, look)`. It returns the
  `StageLayer` list for the stage. The storeys below the cut are solid massing in the prototype
  grid. The cut storey comes from `buildStorey`. The storeys above the cut are an outline only,
  so the height of the building still reads.
- `storeyIndex: null` returns the whole building uncut.
- Add `setStorey(storeyIndex)`, `onPick` and `onHover` to the stage. The stage raycasts the
  pointer against the floor slabs and reports a `Pick`. A storey has few slabs, so a plain
  `Raycaster` is enough.
- Add a storey picker to each cell of the look page. It lists the storey labels and marks the
  storeys that hold scanned space.
- Create `storey.test.ts`. Check that a wall with one door splits into two segments with a gap of
  the door's width, that an opening on another edge leaves the wall whole and that a shared wall
  appears once. Create `floorTone.test.ts`. Check "Bathroom", "Conference Room", "Open Office",
  "Dining Hall" (`living`, because `living` comes before `circulation`) and "Xyz" (`other`).

## Data structures

- `FloorTone`: `'wet' | 'meet' | 'living' | 'storage' | 'circulation' | 'work' | 'other'`.
- `FLOOR_KEYWORDS`, in this order: `wet` (bath, restroom, toilet, shower, kitchen, laundry),
  `meet` (conference, meeting, board, training), `living` (living, bed, dining, lounge, break),
  `storage` (storage, warehouse, closet, garage, dock, mechanical, utility), `circulation`
  (corridor, hall, lobby, entry, foyer, stair, elevator, reception), `work` (office, work, desk,
  studio). When a label from a real scan falls to `other`, add its keyword here.
- `Pick`: `{storeyIndex, spaceId | null, at}`, where `at` is `[x, y]` in the building frame.
- `WallSegment`: `{a, b}`, two `[x, y]` points.

## Verification

1. Run `pnpm --dir app/web typecheck` and `pnpm --dir app/web test`.
2. Start the web app on port 5174 and record its PID.
3. Open the look page and pick the scanned storey of the office tower. Take one screenshot at
   1440 by 900 and save it to your scratchpad. Doors show as gaps, each room use has its own
   colour and the wall caps are dark.
4. If a wall hides a door behind it, lower `wallStubM`. Record the value in
   `decisions-lane-a.tsv`.
5. Stop the PID you recorded. Run the ownership check with `--lane lane-a`.

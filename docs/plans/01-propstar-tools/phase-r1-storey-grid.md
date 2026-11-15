# Phase r1: Storey grid

Part of [the plan overview](overview.md).

Lane A, routing track, phase 1. It depends on [f3](phase-f3-building-model.md) and starts no
server.

## Goal

A storey becomes a grid of cells that a path search can walk. After this phase a route can cross
from one space to the next only through a door.

## Changes

- Create `app/server/src/ops/route/grid.ts` with `buildStoreyGrid(storey, cellM = 0.25)`,
  `cellAt(grid, point)`, `cellCentre(grid, cell)` and `neighbours(grid, cell)`.
- A cell is walkable when its centre lies inside a space ring. Test it with `pointInRing`.
  `spaceIndex` holds the index of the space for each cell, or -1.
- Mark the cells of each opening. An opening's `bearingDeg` is the normal of its wall, so the
  opening runs at right angles to it, `widthM` long and centred on `at`. Mark a band three cells
  deep, so the door bridges the wall between two rings. `doorIndex` holds the index of the
  opening for each cell, or -1.
- Two neighbouring cells connect when they share a space, or when one of them is a door cell of an
  opening whose `spaceIds` names both spaces. Walls then need no cells of their own.
- Cells connect in eight directions. A diagonal step needs both of its straight neighbours to be
  walkable, so a route never cuts a wall corner.
- `neighbours` is a generator that applies those two rules. [r3](phase-r3-route-solve.md) builds
  its graph from it, so the rules live in one place.
- Fill `clearanceM` with the distance from each cell to the nearest cell that is not walkable.
  Use a two-pass chamfer transform. Door cells count as walkable here.
- Ignore furnishings. Every furnishing is inferred, and a guessed desk must not block a route.
- Create `grid.test.ts` from `FIXTURES`. Check that every space owns at least one cell, that a
  flood fill from one room does not reach the next room without a door, that it does with one and
  that the clearance at the centre of a 4 m room is near 2 m.

## Data structures

- `StoreyGrid`: `{storeyIndex, cellM, originX, originY, cols, rows, spaceIndex: Int16Array,
  doorIndex: Int16Array, clearanceM: Float32Array}`. Cell `i` is column `i % cols` and row
  `Math.floor(i / cols)`. The origin is the south-west corner of the storey ring's bounds.
- A storey of 50 by 30 m has 24,000 cells.

## Verification

1. Run `pnpm --dir app/server typecheck` and `pnpm --dir app/server test`.
2. The test prints the time to build the grid of the largest fixture. It is under 100 ms. Record
   it in `decisions-lane-a.tsv`.
3. Run the ownership check with `--lane lane-a`.

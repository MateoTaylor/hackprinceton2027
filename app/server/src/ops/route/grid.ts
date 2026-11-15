import type { Point, Storey } from '../../model/building.ts'
import { pointInRing, ringBounds } from '../../model/geo.ts'

// A storey cut into square cells for a path search. Cell `i` is column `i % cols` and row
// `Math.floor(i / cols)`, counted from the south-west corner of the storey ring's bounds at
// `originX`, `originY`. `spaceIndex` and `doorIndex` hold the index of the space and the opening
// over each cell, or -1. `doorSpaces` holds the space indexes on the two sides of each opening, with
// -1 for the outside of an exterior door. `clearanceM` is the distance from a cell to the nearest
// cell a route cannot step to, and 0 on a cell that is not walkable.
export interface StoreyGrid {
  storeyIndex: number
  cellM: number
  originX: number
  originY: number
  cols: number
  rows: number
  spaceIndex: Int16Array
  doorIndex: Int16Array
  doorSpaces: (readonly [number, number])[]
  clearanceM: Float32Array
}

const NONE = -1
const DOOR_DEPTH_CELLS = 3
const RAD = Math.PI / 180
const EPSILON_M = 1e-9
const AROUND = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const
const BEFORE = [[-1, 0], [-1, -1], [0, -1], [1, -1]] as const
const AFTER = [[1, 0], [1, 1], [0, 1], [-1, 1]] as const

// Furnishings never block a cell.
//   const grid = buildStoreyGrid(building.storeys[0])
export function buildStoreyGrid(storey: Storey, cellM = 0.25): StoreyGrid {
  const { minX, minY, maxX, maxY } = ringBounds(storey.ring)
  const cols = Math.ceil((maxX - minX) / cellM)
  const rows = Math.ceil((maxY - minY) / cellM)
  const spaceIds = storey.spaces.map(({ id }) => id)
  const grid: StoreyGrid = {
    storeyIndex: storey.index,
    cellM,
    originX: minX,
    originY: minY,
    cols,
    rows,
    spaceIndex: new Int16Array(cols * rows).fill(NONE),
    doorIndex: new Int16Array(cols * rows).fill(NONE),
    doorSpaces: storey.openings.map(({ spaceIds: [a, b] }) => [spaceIds.indexOf(a), b === null ? NONE : spaceIds.indexOf(b)]),
    clearanceM: new Float32Array(cols * rows),
  }
  storey.spaces.forEach(({ ring }, space) => {
    const bounds = ringBounds(ring)
    forCellsIn(grid, bounds.minX, bounds.minY, bounds.maxX, bounds.maxY, (cell, centre) => {
      if (grid.spaceIndex[cell] === NONE && pointInRing(centre, ring)) grid.spaceIndex[cell] = space
    })
  })
  storey.openings.forEach(({ at: [ax, ay], widthM, bearingDeg }, door) => {
    const [nx, ny] = [Math.sin(bearingDeg * RAD), Math.cos(bearingDeg * RAD)]
    const halfWidth = widthM / 2 + EPSILON_M
    const halfDepth = (DOOR_DEPTH_CELLS * cellM) / 2 + EPSILON_M
    const reachX = Math.abs(ny) * halfWidth + Math.abs(nx) * halfDepth
    const reachY = Math.abs(nx) * halfWidth + Math.abs(ny) * halfDepth
    forCellsIn(grid, ax - reachX, ay - reachY, ax + reachX, ay + reachY, (cell, [x, y]) => {
      const along = (x - ax) * ny - (y - ay) * nx
      const across = (x - ax) * nx + (y - ay) * ny
      const space = grid.spaceIndex[cell]
      const joined = space === NONE || grid.doorSpaces[door].includes(space)
      if (joined && Math.abs(along) <= halfWidth && Math.abs(across) <= halfDepth) grid.doorIndex[cell] = door
    })
  })
  chamferClearance(grid)
  return grid
}

// The cell under a point of the building frame, or -1 off the grid.
export function cellAt({ cellM, originX, originY, cols, rows }: StoreyGrid, [x, y]: Point) {
  const col = Math.floor((x - originX) / cellM)
  const row = Math.floor((y - originY) / cellM)
  return col >= 0 && col < cols && row >= 0 && row < rows ? row * cols + col : NONE
}

export function cellCentre({ cellM, originX, originY, cols }: StoreyGrid, cell: number): Point {
  return [originX + ((cell % cols) + 0.5) * cellM, originY + (Math.floor(cell / cols) + 0.5) * cellM]
}

export function isWalkable({ spaceIndex, doorIndex }: StoreyGrid, cell: number) {
  return spaceIndex[cell] !== NONE || doorIndex[cell] !== NONE
}

// The cells one step from `cell` in eight directions. A step stays in one space or passes through a
// door that joins the two spaces, and a diagonal step needs both straight steps beside it, so a
// route never cuts a wall corner.
export function* neighbours(grid: StoreyGrid, cell: number) {
  for (const [dc, dr] of AROUND) {
    const next = stepTo(grid, cell, dc, dr)
    if (next !== NONE) yield { cell: next, stepM: stepLengthM(grid, dc, dr) }
  }
}

const stepLengthM = ({ cellM }: StoreyGrid, dc: number, dr: number) => (dc && dr ? cellM * Math.SQRT2 : cellM)

function stepTo(grid: StoreyGrid, cell: number, dc: number, dr: number): number {
  const next = offset(grid, cell, dc, dr)
  if (next === NONE || !connects(grid, cell, next)) return NONE
  if (!dc || !dr) return next
  const [across, up] = [offset(grid, cell, dc, 0), offset(grid, cell, 0, dr)]
  const corner = (side: number) => connects(grid, cell, side) && connects(grid, side, next)
  return corner(across) && corner(up) ? next : NONE
}

function offset({ cols, rows }: StoreyGrid, cell: number, dc: number, dr: number) {
  const [col, row] = [(cell % cols) + dc, Math.floor(cell / cols) + dr]
  return col >= 0 && col < cols && row >= 0 && row < rows ? row * cols + col : NONE
}

function connects(grid: StoreyGrid, a: number, b: number) {
  if (!isWalkable(grid, a) || !isWalkable(grid, b)) return false
  const { spaceIndex, doorIndex, doorSpaces } = grid
  const [spaceA, spaceB, doorA, doorB] = [spaceIndex[a], spaceIndex[b], doorIndex[a], doorIndex[b]]
  if (spaceA !== NONE && spaceA === spaceB) return true
  if (doorA !== NONE && (doorA === doorB || doorSpaces[doorA].includes(spaceB))) return true
  return doorB !== NONE && doorSpaces[doorB].includes(spaceA)
}

function forCellsIn(grid: StoreyGrid, minX: number, minY: number, maxX: number, maxY: number, visit: (cell: number, centre: Point) => void) {
  const { cellM, originX, originY, cols, rows } = grid
  const [col0, col1] = [Math.max(0, Math.floor((minX - originX) / cellM)), Math.min(cols - 1, Math.floor((maxX - originX) / cellM))]
  const [row0, row1] = [Math.max(0, Math.floor((minY - originY) / cellM)), Math.min(rows - 1, Math.floor((maxY - originY) / cellM))]
  for (let row = row0; row <= row1; row++) {
    for (let col = col0; col <= col1; col++) visit(row * cols + col, cellCentre(grid, row * cols + col))
  }
}

function chamferClearance(grid: StoreyGrid) {
  const { cols, rows, clearanceM } = grid
  const relax = (cell: number, steps: readonly (readonly [number, number])[]) => {
    for (const [dc, dr] of steps) {
      const stepM = stepLengthM(grid, dc, dr)
      const next = stepTo(grid, cell, dc, dr)
      clearanceM[cell] = Math.min(clearanceM[cell], next === NONE ? stepM : clearanceM[next] + stepM)
    }
  }
  for (let cell = 0; cell < cols * rows; cell++) {
    clearanceM[cell] = isWalkable(grid, cell) ? Infinity : 0
    if (clearanceM[cell]) relax(cell, BEFORE)
  }
  for (let cell = cols * rows - 1; cell >= 0; cell--) {
    if (clearanceM[cell]) relax(cell, AFTER)
  }
}

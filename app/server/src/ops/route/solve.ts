import type { BuildingModel, Connector, Point } from '../../model/building.ts'
import { distanceM, ringCentroid } from '../../model/geo.ts'
import { OpError } from '../op.ts'
import { type DoorFit, doorFit, type Payload } from './doorFit.ts'
import { buildStoreyGrid, cellAt, cellCentre, crossedDoor, isWalkable, neighbours, type StoreyGrid } from './grid.ts'

// A link into a failing door costs this much more, so a failing door is a last resort.
export const FAIL_PENALTY_M = 1000
const ELEVATOR_EXTRA_M = 10
const LANDING_SNAP_M = 1
const NONE = -1

export type RouteTarget = { spaceId: string } | { at: Point; storeyIndex?: number }

// A door the route passes, with the storey it is on and its centre.
export type RouteDoor = DoorFit & { storeyIndex: number; at: Point }

// One found route from a storey-0 exterior door. `trail` is `[x, y, storeyIndex]` from the
// entrance to the target, with collinear points dropped. `lengthM` leaves out the failing-door
// penalty and counts a connector as its rise.
export type Route = {
  lengthM: number
  doors: RouteDoor[]
  failCount: number
  confidence: number
  connector: Pick<Connector, 'id' | 'kind'> | null
  usesElevator: boolean
  usesDefaultDoorHeight: boolean
  trail: [number, number, number][]
}

type ResolvedTarget = { spaceId: string | null; storeyIndex: number; cell: number; at: Point }
type Hop = { to: number; costM: number; connector: Connector }
// One cell of a found path, with the connector taken to reach it from the storey before.
type Step = { storey: number; cell: number; via: Connector | null }

// The best route from a storey-0 exterior door to a space or a point for one payload, found by A*
// over the storey grids joined by the connectors. A door counts only where the route crosses it
// into another space, not where it passes beside one. `route` is null when no way in exists. It
// throws `not_found` for an unknown space, `invalid_input` for a point off every walkable cell and
// `no_data` when storey 0 has no exterior door.
//   const { route } = solveRoute(FIXTURES.officeTower, { spaceId: 's5-east' }, PAYLOAD_PRESETS.wheelchair.payload)
export function solveRoute(building: BuildingModel, target: RouteTarget, payload: Payload) {
  const { storeys } = building
  const grids = storeys.map((storey) => buildStoreyGrid(storey))
  const fits = storeys.map(({ openings }) => openings.map((opening) => doorFit(opening, payload)))
  const end = resolveTarget(building, grids, target)

  const offsets: number[] = []
  const total = grids.reduce((offset, { cols, rows }) => (offsets.push(offset), offset + cols * rows), 0)
  const storeyOf = new Uint16Array(total)
  grids.forEach(({ cols, rows }, storey) => storeyOf.fill(storey, offsets[storey], offsets[storey] + cols * rows))
  const hops = new Map<number, Hop[]>()
  for (const connector of building.connectors) {
    if (connector.kind === 'stair' && payload.wheeled) continue
    const landings = connector.landings.flatMap(({ storeyIndex, at }) => {
      const cell = grids[storeyIndex] ? snapToWalkable(grids[storeyIndex], at) : NONE
      return cell === NONE ? [] : [{ storey: storeyIndex, id: offsets[storeyIndex] + cell }]
    })
    for (const a of landings) {
      for (const b of landings) {
        const riseM = Math.abs(storeys[a.storey].elevationM - storeys[b.storey].elevationM)
        const costM = connector.kind === 'stair' ? 2 * riseM : riseM + ELEVATOR_EXTRA_M
        if (a.storey !== b.storey) hops.set(a.id, [...(hops.get(a.id) ?? []), { to: b.id, costM, connector }])
      }
    }
  }

  // A failing door costs the penalty once, on the step that crosses it into another space. The
  // entrance is charged where the route starts, so its own crossing into the first room is free.
  const failingDoor = (storey: number, door: number) => door !== NONE && fits[storey][door].verdict === 'fail'
  const penaltyOf = (storey: number, from: number, to: number) => {
    const door = crossedDoor(grids[storey], from, to)
    return failingDoor(storey, door) && !grids[storey].doorSpaces[door].includes(NONE) ? FAIL_PENALTY_M : 0
  }
  const goal = offsets[end.storeyIndex] + end.cell
  const goalZ = storeys[end.storeyIndex].elevationM
  const [goalX, goalY] = cellCentre(grids[end.storeyIndex], end.cell)
  const estimate = (id: number) => {
    const storey = storeyOf[id]
    const [x, y] = cellCentre(grids[storey], id - offsets[storey])
    return Math.hypot(x - goalX, y - goalY) + Math.abs(storeys[storey].elevationM - goalZ)
  }
  const costM = new Float64Array(total).fill(Infinity)
  const cameFrom = new Int32Array(total).fill(NONE)
  const arrivedBy = new Map<number, Connector>()
  const done = new Uint8Array(total)
  const open = new MinHeap()
  const reach = (id: number, nextCostM: number, from: number, via: Connector | null) => {
    if (nextCostM >= costM[id]) return
    costM[id] = nextCostM
    cameFrom[id] = from
    if (via) arrivedBy.set(id, via)
    else arrivedBy.delete(id)
    open.push(id, nextCostM + estimate(id))
  }
  const ground = grids[0]
  if (!storeys[0].openings.some(({ kind }) => kind === 'exterior_door')) {
    throw new OpError('no_data', 'This building has no street entrance on its ground storey yet.', 'Check building_get for an exterior_door on storey 0.')
  }
  for (let cell = 0; cell < ground.cols * ground.rows; cell++) {
    const door = ground.doorIndex[cell]
    if (door !== NONE && storeys[0].openings[door].kind === 'exterior_door') reach(cell, failingDoor(0, door) ? FAIL_PENALTY_M : 0, NONE, null)
  }
  for (let id = open.pop(); id !== undefined && id !== goal; id = open.pop()) {
    if (done[id]) continue
    done[id] = 1
    const storey = storeyOf[id]
    const cell = id - offsets[storey]
    for (const next of neighbours(grids[storey], cell)) {
      reach(offsets[storey] + next.cell, costM[id] + next.stepM + penaltyOf(storey, cell, next.cell), id, null)
    }
    for (const hop of hops.get(id) ?? []) reach(hop.to, costM[id] + hop.costM, id, hop.connector)
  }

  const path: Step[] = []
  if (costM[goal] < Infinity) {
    for (let id = goal; id !== NONE; id = cameFrom[id]) {
      path.push({ storey: storeyOf[id], cell: id - offsets[storeyOf[id]], via: arrivedBy.get(id) ?? null })
    }
  }
  const route: Route | null = path.length ? walk(building, grids, fits, path.reverse()) : null
  return { target: { spaceId: end.spaceId, storeyIndex: end.storeyIndex, at: end.at }, route }
}

function walk({ storeys }: BuildingModel, grids: StoreyGrid[], fits: DoorFit[][], path: Step[]) {
  const doors: RouteDoor[] = []
  const seen = new Set<string>()
  const points: [number, number, number][] = []
  let lengthM = 0
  let leastInferred = 1
  let connector: Route['connector'] = null
  let usesElevator = false
  let usesDefaultDoorHeight = false
  const pass = (storey: number, door: number) => {
    if (door === NONE || seen.has(`${storey}:${door}`)) return
    seen.add(`${storey}:${door}`)
    const opening = storeys[storey].openings[door]
    usesDefaultDoorHeight ||= opening.heightM === null
    doors.push({ ...fits[storey][door], storeyIndex: storey, at: opening.at })
  }
  // The space the route last stood in, so a dip into a door's gap and back is not a pass.
  let lastSpace = NONE
  const placed = path.map(({ storey, cell, via }) => ({ storey, cell, via, at: cellCentre(grids[storey], cell), z: storeys[storey].elevationM }))
  placed.forEach(({ storey, cell, via, at: [x, y], z }, i) => {
    const grid = grids[storey]
    const previous = placed[i - 1]
    if (!previous) pass(storey, grid.doorIndex[cell])
    else if (!via && grid.spaceIndex[cell] !== lastSpace) pass(storey, crossedDoor(grid, previous.cell, cell))
    if (via || grid.spaceIndex[cell] !== NONE) lastSpace = grid.spaceIndex[cell]
    const space = grid.spaceIndex[cell] === NONE ? null : storeys[storey].spaces[grid.spaceIndex[cell]]
    if (space?.source === 'inferred') leastInferred = Math.min(leastInferred, space.confidence)
    if (previous && !via) lengthM += distanceM(previous.at, [x, y])
    if (previous && via) {
      lengthM += Math.abs(z - previous.z)
      connector ??= { id: via.id, kind: via.kind }
      usesElevator ||= via.kind === 'elevator'
      if (via.source === 'inferred') leastInferred = Math.min(leastInferred, via.confidence)
    }
    points.push([round(x), round(y), storey])
  })
  const leastDoor = Math.min(1, ...doors.map(({ confidence }) => confidence))
  return {
    lengthM: round(lengthM),
    doors,
    failCount: doors.filter(({ verdict }) => verdict === 'fail').length,
    confidence: round(leastDoor * leastInferred),
    connector,
    usesElevator,
    usesDefaultDoorHeight,
    trail: points.filter((point, i) => !isCollinear(points[i - 1], point, points[i + 1])),
  }
}

function isCollinear(a: [number, number, number] | undefined, b: [number, number, number], c: [number, number, number] | undefined) {
  if (!a || !c || a[2] !== b[2] || c[2] !== b[2]) return false
  return Math.abs((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])) < 1e-9
}

function resolveTarget({ storeys }: BuildingModel, grids: StoreyGrid[], target: RouteTarget): ResolvedTarget {
  if ('spaceId' in target) {
    const storeyIndex = storeys.findIndex(({ spaces }) => spaces.some(({ id }) => id === target.spaceId))
    if (storeyIndex === NONE) throw new OpError('not_found', `No space has the id "${target.spaceId}".`, 'List the space ids with building_get.')
    const { spaces } = storeys[storeyIndex]
    const space = spaces.findIndex(({ id }) => id === target.spaceId)
    const grid = grids[storeyIndex]
    const centre = ringCentroid(spaces[space].ring)
    let cell = NONE
    for (let next = 0, bestM = Infinity; next < grid.cols * grid.rows; next++) {
      const nextM = grid.spaceIndex[next] === space ? distanceM(cellCentre(grid, next), centre) : Infinity
      if (nextM < bestM) [cell, bestM] = [next, nextM]
    }
    if (cell === NONE) throw new OpError('no_data', 'That space is too small to route to.', 'Pick a larger space.')
    return { spaceId: target.spaceId, storeyIndex, cell, at: cellCentre(grid, cell) }
  }
  const { at, storeyIndex } = target
  const grid = storeyIndex === undefined ? undefined : grids[storeyIndex]
  if (storeyIndex === undefined || !grid) {
    throw new OpError('invalid_input', 'An { at } target needs the storeyIndex of a storey of this building.', 'Pass storeyIndex from building_get.')
  }
  const cell = cellAt(grid, at)
  if (cell === NONE || !isWalkable(grid, cell)) {
    throw new OpError('invalid_input', `That point is not inside a space on storey ${storeyIndex}.`, 'Pick a point inside a space from building_get.')
  }
  return { spaceId: null, storeyIndex, cell, at }
}

// The walkable cell under `at`, or the nearest within LANDING_SNAP_M, or -1.
function snapToWalkable(grid: StoreyGrid, at: Point) {
  const under = cellAt(grid, at)
  if (under !== NONE && isWalkable(grid, under)) return under
  const reach = Math.ceil(LANDING_SNAP_M / grid.cellM)
  const [col0, row0] = [Math.floor((at[0] - grid.originX) / grid.cellM), Math.floor((at[1] - grid.originY) / grid.cellM)]
  let [cell, bestM] = [NONE, LANDING_SNAP_M]
  for (let row = row0 - reach; row <= row0 + reach; row++) {
    for (let col = col0 - reach; col <= col0 + reach; col++) {
      if (col < 0 || col >= grid.cols || row < 0 || row >= grid.rows) continue
      const next = row * grid.cols + col
      const nextM = isWalkable(grid, next) ? distanceM(cellCentre(grid, next), at) : Infinity
      if (nextM <= bestM) [cell, bestM] = [next, nextM]
    }
  }
  return cell
}

const round = (value: number) => Math.round(value * 100) / 100

// A binary min-heap of ids by priority. An id may sit in it more than once; the caller skips the
// copies it has already finished.
class MinHeap {
  private ids: number[] = []
  private priorities: number[] = []

  push(id: number, priority: number) {
    const { ids, priorities } = this
    let i = ids.push(id) - 1
    priorities.push(priority)
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (priorities[parent] <= priority) break
      ;[ids[i], priorities[i]] = [ids[parent], priorities[parent]]
      i = parent
    }
    ;[ids[i], priorities[i]] = [id, priority]
  }

  pop() {
    const { ids, priorities } = this
    const top = ids[0]
    const [lastId, lastPriority] = [ids.pop(), priorities.pop()]
    if (!ids.length || lastId === undefined || lastPriority === undefined) return top
    let i = 0
    for (let child = 1; child < ids.length; child = 2 * i + 1) {
      if (child + 1 < ids.length && priorities[child + 1] < priorities[child]) child++
      if (priorities[child] >= lastPriority) break
      ;[ids[i], priorities[i]] = [ids[child], priorities[child]]
      i = child
    }
    ;[ids[i], priorities[i]] = [lastId, lastPriority]
    return top
  }
}

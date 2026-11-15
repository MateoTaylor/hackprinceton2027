import type { FloorPlan, Matterport } from '../../matterport.ts'
import type { Point, Ring } from '../../model/building.ts'
import { bearingDeg, orientCcw, pointInRing, ringArea } from '../../model/geo.ts'
import { OpError } from '../op.ts'
import { closeGaps, subtractSplit } from './clip.ts'
import { convexHull, doorBetween, nearestOnRing } from './geometry.ts'

const LABEL_MAX = 60
// Matterport draws each room inside its walls, so rooms stand apart by up to twice this.
const WALL_GAP_M = 0.3
// A point this far off an edge midpoint, to tell which side of the edge a room lies on.
const SIDE_PROBE_M = 0.05
// Pieces of the open floor smaller than this are wall slivers, not floor.
const MIN_PIECE_M2 = 1
// Two pieces of the open floor that share less wall than this are not joined.
const SEAM_MIN_M = 0.9
// Room ids leave room for the suffix that numbers the pieces of the open floor.
const REST_SUFFIX = 4

export type ScanSpace = { id: string; label: string; ring: Ring; areaM2: number; ceilingM: number | null; stair: boolean }
export type ScanOpening = {
  id: string
  kind: 'door' | 'opening' | 'exterior_door'
  at: Point
  widthM: number
  heightM: number | null
  bearingDeg: number
  spaceIds: [string, string | null]
}
// `outline` is the convex hull of the floor's walls, because the rooms alone leave out the open
// floor between them.
export type ScanFloor = { id: string; sequence: number; label: string; outline: Ring; spaces: ScanSpace[]; openings: ScanOpening[] }
export type ScanPlan = { modelId: string; floors: ScanFloor[]; skippedRooms: number }

type PlanFloor = FloorPlan['floors'][number]
type PlanRoom = FloorPlan['rooms'][number]

type Vertices = Map<string, Point>

const verticesOf = (floor: PlanFloor): Vertices => new Map(floor.vertices.map(({ id, x, y }) => [id, [x, y]]))

// Chains a room's boundary edges into one ring by matching vertex ids end to end, or returns null
// when they do not close.
function chainRing(edgeIds: string[], edgeVertices: Map<string, string[]>, vertices: Vertices): Ring | null {
  const pending = edgeIds.flatMap((id) => {
    const pair = edgeVertices.get(id)
    return pair?.length === 2 ? [pair] : []
  })
  if (pending.length < 3 || pending.length !== edgeIds.length) return null
  const chain = [...pending[0]]
  pending.splice(0, 1)
  while (pending.length) {
    const tail = chain[chain.length - 1]
    const next = pending.findIndex((pair) => pair.includes(tail))
    if (next < 0) return null
    const [[from, to]] = pending.splice(next, 1)
    chain.push(from === tail ? to : from)
  }
  if (chain[chain.length - 1] !== chain[0]) return null
  const ring = chain.slice(0, -1).flatMap((id) => {
    const point = vertices.get(id)
    return point ? [point] : []
  })
  return ring.length === chain.length - 1 ? orientCcw(ring) : null
}

function labelOf({ label, classifications }: PlanRoom) {
  const best = classifications.toSorted((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0]?.label
  return (best || label || 'Room').slice(0, LABEL_MAX)
}

// The compass bearing of the edge normal that points out of `ring`, at `at` on edge `a` to `b`.
function outwardBearing(a: Point, b: Point, at: Point, ring: Ring) {
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
  const left: Point = [-(b[1] - a[1]) / length, (b[0] - a[0]) / length]
  const probe: Point = [at[0] + left[0] * SIDE_PROBE_M, at[1] + left[1] * SIDE_PROBE_M]
  const outward: Point = pointInRing(probe, ring) ? [-left[0], -left[1]] : left
  return bearingDeg([0, 0], outward)
}

const spaceOf = (id: string, label: string, ring: Ring, ceilingM: number | null): ScanSpace => ({
  id,
  label,
  ring,
  areaM2: ringArea(ring),
  ceilingM,
  stair: /stair/i.test(label),
})

// The open floor around the rooms: the floor outline less the rooms, cut into pieces with no hole
// and joined to each other by wide openings.
function restOfFloor(rest: { id: string; label: string; ceilingM: number | null }, outline: Ring, rooms: Ring[]) {
  const pieces = subtractSplit([outline], closeGaps(rooms, WALL_GAP_M)).filter((ring) => ringArea(ring) >= MIN_PIECE_M2)
  const spaces = pieces.map((ring, k) => spaceOf(`${rest.id}-${k + 1}`.slice(0, 64), rest.label, ring, rest.ceilingM))
  const openings = spaces.flatMap((a, i) =>
    spaces.slice(i + 1).flatMap((b, j): ScanOpening[] => {
      const door = doorBetween(a.ring, b.ring)
      if (!door || door.sharedM < SEAM_MIN_M) return []
      const id = `${rest.id}-seam-${i + 1}-${i + j + 2}`.slice(0, 64)
      return [{ id, kind: 'opening', at: door.at, widthM: door.sharedM, heightM: null, bearingDeg: door.bearingDeg, spaceIds: [a.id, b.id] }]
    }),
  )
  return { spaces, openings }
}

function parseFloor(modelId: string, floor: PlanFloor, rooms: PlanRoom[]) {
  const vertices = verticesOf(floor)
  const edgeVertices = new Map(floor.edges.map(({ id, vertexIds }) => [id, vertexIds]))
  const spaces: ScanSpace[] = []
  const roomsOfEdge = new Map<string, string[]>()
  let rest: { id: string; label: string; ceilingM: number | null } | null = null
  let skipped = 0
  for (const room of rooms) {
    const id = `${modelId}-${room.id}`.slice(0, 64 - REST_SUFFIX)
    const ceilingM = room.ceiling?.maxHeight ?? room.ceiling?.minHeight ?? null
    const ring = chainRing(room.boundaryEdgeIds, edgeVertices, vertices)
    if (ring && ringArea(ring) > 0) spaces.push(spaceOf(id, labelOf(room), ring, ceilingM))
    // The open floor of a scan comes as one room around the others, with holes where they stand.
    else if (!rest && room.holeEdgeIds.length) rest = { id, label: labelOf(room), ceilingM }
    else {
      skipped++
      continue
    }
    const walls = ring ? room.boundaryEdgeIds : [...room.boundaryEdgeIds, ...room.holeEdgeIds]
    for (const edgeId of new Set(walls)) roomsOfEdge.set(edgeId, [...new Set([...(roomsOfEdge.get(edgeId) ?? []), id])])
  }
  const points = [...vertices.values()]
  if (!spaces.length && !rest) return { floor: null, skipped }
  const outline = convexHull(points.length >= 3 ? points : spaces.flatMap(({ ring }) => ring))
  const open = rest ? restOfFloor(rest, outline, spaces.map(({ ring }) => ring)) : { spaces: [], openings: [] }
  spaces.push(...open.spaces)
  const ringOf = new Map(spaces.map(({ id, ring }) => [id, ring]))
  // An opening onto the open floor goes to the piece of it nearest the opening.
  const resolve = (id: string, at: Point) =>
    id !== rest?.id ? id : open.spaces.reduce<{ id: string | null; distanceM: number }>((best, piece) => {
      const { distanceM } = nearestOnRing(at, piece.ring)
      return distanceM < best.distanceM ? { id: piece.id, distanceM } : best
    }, { id: null, distanceM: Infinity }).id

  // `relativeCenter` is the fraction along the edge where the opening's centre sits.
  const openings = floor.edges.flatMap((edge) => {
    const [a, b] = edge.vertexIds.map((id) => vertices.get(id))
    const users = roomsOfEdge.get(edge.id) ?? []
    if (!a || !b || !users.length) return []
    return edge.openings.flatMap((opening): ScanOpening[] => {
      if (opening.widthM <= 0) return []
      const t = Math.min(1, Math.max(0, opening.relativeCenter ?? 0.5))
      const at: Point = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
      const [from, to] = users.map((id) => resolve(id, at))
      const fromRing = ringOf.get(from ?? '')
      if (!from || !fromRing) return []
      const base = {
        id: `${modelId}-${opening.id}`.slice(0, 64),
        at,
        widthM: opening.widthM,
        heightM: opening.heightM && opening.heightM > 0 ? opening.heightM : null,
        bearingDeg: outwardBearing(a, b, at, fromRing),
      }
      if (users.length === 1) return opening.type === 'doorway' ? [{ ...base, kind: 'exterior_door', spaceIds: [from, null] }] : []
      if (!to || to === from) return []
      return [{ ...base, kind: opening.type === 'doorway' ? 'door' : 'opening', spaceIds: [from, to] }]
    })
  })

  return { floor: { id: floor.id, sequence: floor.sequence, label: floor.label, outline, spaces, openings: [...openings, ...open.openings] }, skipped }
}

// A Matterport floor plan as rings, openings and labels in the scan's own frame, in metres. A
// room whose edges do not close is counted in `skippedRooms`, except the first one with holes,
// which is the open floor around the other rooms. A floor with no room is dropped.
//   const plan = parseScanPlan('aYTUWzQVbUs', await matterport.floorPlan('aYTUWzQVbUs'))
export function parseScanPlan(modelId: string, plan: FloorPlan): ScanPlan {
  let skippedRooms = 0
  const floors = plan.floors.flatMap((floor) => {
    const parsed = parseFloor(
      modelId,
      floor,
      plan.rooms.filter(({ floorId }) => floorId === floor.id),
    )
    skippedRooms += parsed.skipped
    return parsed.floor ? [parsed.floor] : []
  })
  return { modelId, floors: floors.toSorted((a, b) => a.sequence - b.sequence), skippedRooms }
}

// Fetches and parses one scan's floor plan. Throws `not_ready` without the Matterport keys, and
// the client's OpError when Matterport fails.
export async function fetchScanPlan({ matterport }: { matterport: Pick<Matterport, 'floorPlan'> | null }, modelId: string) {
  if (!matterport) throw new OpError('not_ready', 'The Matterport client is off.', 'Add MP_TOKEN_ID and MP_TOKEN_SECRET to the repo-root .env and restart the server.')
  return parseScanPlan(modelId, await matterport.floorPlan(modelId))
}

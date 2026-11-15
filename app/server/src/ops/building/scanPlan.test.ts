import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { FloorPlan } from '../../matterport.ts'
import type { Point } from '../../model/building.ts'
import { ringArea } from '../../model/geo.ts'
import { parseScanPlan } from './scanPlan.ts'

type Wall = { from: Point; to: Point; openings?: { type: string; widthM: number; at?: number }[] }
type RoomSpec = { id: string; label: string; walls: number[]; holes?: number[] }

// An invented one-floor plan. Walls are numbered by their place in `walls`; points equal by value
// share a vertex, as Matterport's do.
function plan(walls: Wall[], rooms: RoomSpec[]): FloorPlan {
  const vertexIds = new Map<string, string>()
  const vertexOf = ([x, y]: Point) => {
    const key = `${x},${y}`
    if (!vertexIds.has(key)) vertexIds.set(key, `v${vertexIds.size}`)
    return vertexIds.get(key) ?? ''
  }
  const edges = walls.map(({ from, to, openings = [] }, i) => ({
    id: `e${i}`,
    type: 'wall',
    thickness: 0.1,
    vertexIds: [vertexOf(from), vertexOf(to)],
    openings: openings.map(({ type, widthM, at }, k) => ({ id: `o${i}-${k}`, type, widthM, heightM: 2.1, lowerElevationM: 0, relativeCenter: at ?? 0.5 })),
  }))
  const vertices = [...vertexIds].map(([key, id]) => {
    const [x, y] = key.split(',').map(Number)
    return { id, x, y }
  })
  return {
    floors: [{ id: 'f0', label: 'Main', sequence: 0, vertices, edges }],
    rooms: rooms.map(({ id, label, walls: boundary, holes = [] }) => ({
      id,
      label,
      floorId: 'f0',
      boundaryEdgeIds: boundary.map((i) => `e${i}`),
      holeEdgeIds: holes.map((i) => `e${i}`),
      classifications: [],
      ceiling: { minHeight: 2.7, maxHeight: 2.7 },
    })),
  }
}

test('two rooms that share a door, an exterior door, a stair and a room that does not close', () => {
  const walls: Wall[] = [
    { from: [0, 0], to: [5, 0] },
    { from: [5, 0], to: [5, 6], openings: [{ type: 'doorway', widthM: 0.9 }] },
    { from: [5, 6], to: [0, 6] },
    { from: [0, 6], to: [0, 0], openings: [{ type: 'doorway', widthM: 1.2, at: 0.25 }] },
    { from: [5, 0], to: [10, 0] },
    { from: [10, 0], to: [10, 6] },
    { from: [10, 6], to: [5, 6] },
    { from: [10, 0], to: [13, 0] },
    { from: [13, 0], to: [13, 3] },
    { from: [13, 3], to: [10, 3] },
    { from: [20, 0], to: [22, 0] },
    { from: [10, 3], to: [10, 0] },
  ]
  const parsed = parseScanPlan('model', plan(walls, [
    { id: 'a', label: 'Office', walls: [0, 1, 2, 3] },
    { id: 'b', label: 'Kitchen', walls: [4, 5, 6, 1] },
    { id: 's', label: 'Stairs', walls: [7, 8, 9, 11] },
    { id: 'x', label: 'Closet', walls: [10] },
  ]))
  assert.equal(parsed.skippedRooms, 1)
  const [floor] = parsed.floors
  assert.deepEqual(floor.spaces.map(({ id, stair }) => [id, stair]), [['model-a', false], ['model-b', false], ['model-s', true]])
  assert.equal(Math.round(floor.spaces[0].areaM2), 30)
  const door = floor.openings.find(({ kind }) => kind === 'door')
  assert.deepEqual(door?.spaceIds, ['model-a', 'model-b'])
  assert.deepEqual(door?.at, [5, 3])
  assert.equal(door?.bearingDeg, 90)
  const exterior = floor.openings.find(({ kind }) => kind === 'exterior_door')
  assert.deepEqual(exterior?.spaceIds, ['model-a', null])
  assert.deepEqual(exterior?.at, [0, 4.5])
  assert.equal(exterior?.bearingDeg, 270)
  assert.equal(floor.openings.length, 2)
})

test('the open floor around rooms becomes pieces with no hole, joined to the rooms', () => {
  const walls: Wall[] = [
    { from: [0, 0], to: [20, 0] },
    { from: [20, 0], to: [20, 10] },
    { from: [20, 10], to: [0, 10] },
    { from: [0, 10], to: [0, 0] },
    { from: [8, 4], to: [12, 4], openings: [{ type: 'doorway', widthM: 0.9 }] },
    { from: [12, 4], to: [12, 6] },
    { from: [12, 6], to: [8, 6] },
    { from: [8, 6], to: [8, 4] },
    { from: [0, 0], to: [3, 2] },
  ]
  const parsed = parseScanPlan('model', plan(walls, [
    { id: 'room', label: 'Office', walls: [4, 5, 6, 7] },
    { id: 'open', label: 'Open space', walls: [0, 1, 2, 3, 8], holes: [4, 5, 6, 7] },
  ]))
  const [floor] = parsed.floors
  const pieces = floor.spaces.filter(({ id }) => id.startsWith('model-open-'))
  assert.ok(pieces.length >= 2)
  const area = floor.spaces.reduce((sum, { ring }) => sum + ringArea(ring), 0)
  assert.ok(Math.abs(area - 200) < 2, `floor area ${area}`)
  const door = floor.openings.find(({ kind }) => kind === 'door')
  assert.equal(door?.spaceIds[0], 'model-room')
  assert.ok(door?.spaceIds[1]?.startsWith('model-open-'))
  assert.ok(floor.openings.some(({ id }) => id.includes('-seam-')))
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { BuildingModel, Opening, Ring } from '../../model/building.ts'
import { FIXTURES } from '../../model/fixtures.ts'
import { PAYLOAD_PRESETS } from './payload.ts'
import { solveRoute } from './solve.ts'

const wheelchair = PAYLOAD_PRESETS.wheelchair.payload
const MEASURED = { source: 'costar', confidence: 1 } as const

const rect = (x0: number, y0: number, x1: number, y1: number): Ring => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
]

const door = (id: string, x: number, widthM: number): Opening => ({
  id,
  kind: 'door',
  at: [x, 4],
  widthM,
  heightM: 2.1,
  bearingDeg: 0,
  spaceIds: ['hall', 'room'],
  ...MEASURED,
})

// A hall along the south with the entrance at its west end, and a room north of it reached by a
// narrow door near the entrance or a wide door at the far end.
function hallAndRoom(doors: Opening[]): BuildingModel {
  return {
    ...FIXTURES.warehouse,
    connectors: [],
    storeys: [
      {
        index: 0,
        label: 'Ground',
        elevationM: 0,
        heightM: 3,
        ring: rect(0, 0, 20, 10),
        ...MEASURED,
        spaces: [
          { id: 'hall', label: 'Hall', ring: rect(0, 0, 20, 4), ...MEASURED },
          { id: 'room', label: 'Room', ring: rect(0, 4, 20, 10), ...MEASURED },
        ],
        openings: [
          { id: 'entrance', kind: 'exterior_door', at: [1, 0], widthM: 1.2, heightM: 2.1, bearingDeg: 180, spaceIds: ['hall', null], ...MEASURED },
          ...doors,
        ],
        furnishings: [],
      },
    ],
  }
}

test('a long way through a wide door beats a short way through a narrow one', () => {
  const { route } = solveRoute(hallAndRoom([door('narrow', 2, 0.6), door('wide', 18, 1.2)]), { spaceId: 'room' }, wheelchair)
  assert.ok(route)
  assert.deepEqual(
    route.doors.map(({ openingId, verdict }) => [openingId, verdict]),
    [
      ['entrance', 'pass'],
      ['wide', 'pass'],
    ],
  )
  assert.equal(route.failCount, 0)
  assert.ok(route.lengthM > 20 && route.lengthM < 40, `length ${route.lengthM} leaves out the penalty`)
})

test('the narrow door is taken, and counted as failing, once the wide way is gone', () => {
  const { route } = solveRoute(hallAndRoom([door('narrow', 2, 0.6)]), { spaceId: 'room' }, wheelchair)
  assert.ok(route)
  assert.equal(route.failCount, 1)
  assert.deepEqual(
    route.doors.map(({ openingId, verdict, limitedBy }) => [openingId, verdict, limitedBy]),
    [
      ['entrance', 'pass', 'width'],
      ['narrow', 'fail', 'width'],
    ],
  )
  assert.ok(route.lengthM < 1000)
})

test('a wheelchair with only a stair upstairs has no way in, and a person takes the stair', () => {
  assert.equal(solveRoute(FIXTURES.apartment, { spaceId: 'a1-unit-ne' }, wheelchair).route, null)
  const { route } = solveRoute(FIXTURES.apartment, { spaceId: 'a1-unit-ne' }, PAYLOAD_PRESETS.person.payload)
  assert.deepEqual(route?.connector, { id: 'apartment-stair', kind: 'stair' })
})

test('a wheelchair reaches storey 5 of the office tower by the elevator in under a second', () => {
  const started = performance.now()
  const { route, target } = solveRoute(FIXTURES.officeTower, { spaceId: 's5-east' }, wheelchair)
  const elapsedMs = performance.now() - started
  console.log(`office tower storey 5 route in ${elapsedMs.toFixed(0)} ms`)
  assert.ok(elapsedMs < 1000)
  assert.equal(target.storeyIndex, 5)
  assert.ok(route)
  assert.deepEqual(route.connector, { id: 'tower-elevator', kind: 'elevator' })
  assert.equal(route.trail[0][2], 0)
  assert.equal(route.trail.at(-1)?.[2], 5)
  // The elevator and the inferred lobby are guesses at 0.5, under the scanned doors' 0.8.
  assert.equal(route.confidence, 0.4)
})

test('an { at } target needs a storey and a point inside a space', () => {
  assert.throws(() => solveRoute(FIXTURES.warehouse, { at: [0, 0] }, wheelchair), { code: 'invalid_input' })
  assert.throws(() => solveRoute(FIXTURES.warehouse, { at: [100, 0], storeyIndex: 0 }, wheelchair), { code: 'invalid_input' })
  assert.equal(solveRoute(FIXTURES.warehouse, { at: [0, 0], storeyIndex: 0 }, wheelchair).target.spaceId, null)
})

test('a door the route only passes beside is not counted', () => {
  const closet: Opening = { id: 'closet-door', kind: 'door', at: [3, 0.01], widthM: 1.2, heightM: 2.1, bearingDeg: 0, spaceIds: ['hall', 'room'], source: 'inferred', confidence: 0.3 }
  const { route } = solveRoute(hallAndRoom([door('wide', 18, 1.2), closet]), { at: [18, 1], storeyIndex: 0 }, wheelchair)
  assert.deepEqual(route?.doors.map(({ openingId }) => openingId), ['entrance'])
  assert.equal(route?.confidence, 0.8)
})

test('a building with no street entrance has no data to route from', () => {
  const [storey] = hallAndRoom([door('wide', 18, 1.2)]).storeys
  const shut = { ...hallAndRoom([]), storeys: [{ ...storey, openings: storey.openings.filter(({ kind }) => kind !== 'exterior_door') }] }
  assert.throws(() => solveRoute(shut, { spaceId: 'room' }, wheelchair), { code: 'no_data' })
})

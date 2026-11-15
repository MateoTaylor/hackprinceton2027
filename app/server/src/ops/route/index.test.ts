import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createDiskCache } from '../../cache.ts'
import type { BuildingModel, Opening, Space } from '../../model/building.ts'
import { FIXTURES } from '../../model/fixtures.ts'
import { createVexcel } from '../../vexcel.ts'
import { type OpContext, RESULT_MAX_CHARS, runOp } from '../op.ts'
import { ROUTE_OPS } from './index.ts'

const [routeSolve] = ROUTE_OPS
const MEASURED = { source: 'costar', confidence: 1 } as const
const ROOMS = 41

// A context whose building_get answers `building` for any property.
function contextWith(building: BuildingModel): OpContext {
  const unusedDir = join(tmpdir(), 'propstar-route-test-unused')
  return {
    properties: new Map(),
    vexcel: createVexcel({ apiKey: 'k', cache: createDiskCache(unusedDir) }),
    matterport: null,
    buildingFacts: new Map(),
    dataDir: unusedDir,
    edit: async () => {
      throw new Error('route_solve never calls the edit API')
    },
    call: async () => ({ result: {}, detail: { building, unplacedScans: [] } }),
  }
}

// A row of rooms 2 m wide, each joined to the next by a door, with the entrance in the first.
function rowOfRooms(): BuildingModel {
  const spaces = Array.from({ length: ROOMS }, (_, n): Space => ({
    id: `r${n}`,
    label: `Room ${n}`,
    ring: [
      [2 * n, 0],
      [2 * n + 2, 0],
      [2 * n + 2, 4],
      [2 * n, 4],
    ],
    ...MEASURED,
  }))
  const doors = spaces.slice(1).map(({ id }, n): Opening => ({
    id: `${id}-door`,
    kind: 'door',
    at: [2 * n + 2, 2],
    widthM: 1,
    heightM: 2.1,
    bearingDeg: 90,
    spaceIds: [`r${n}`, id],
    ...MEASURED,
  }))
  const entrance: Opening = { id: 'entrance', kind: 'exterior_door', at: [0, 2], widthM: 1.2, heightM: 2.1, bearingDeg: 270, spaceIds: ['r0', null], ...MEASURED }
  const [storey] = FIXTURES.warehouse.storeys
  return {
    ...FIXTURES.warehouse,
    storeys: [{ ...storey, ring: [[0, 0], [2 * ROOMS, 0], [2 * ROOMS, 4], [0, 4]], spaces, openings: [entrance, ...doors], furnishings: [] }],
  }
}

test('a route through 41 doors keeps its result under the size limit and lists the first 20', async () => {
  const envelope = await runOp(routeSolve, contextWith(rowOfRooms()), { propertyId: 'p', target: { spaceId: `r${ROOMS - 1}` }, payload: 'wheelchair' }, { detail: true })
  assert.ok(envelope.ok)
  assert.equal(envelope.result.doorCount, ROOMS)
  assert.equal(envelope.result.doors.length, 20)
  assert.equal(envelope.detail?.doors.length, ROOMS)
  assert.ok(JSON.stringify(envelope.result).length < RESULT_MAX_CHARS)
})

test('route_solve names its failures', async () => {
  const ctx = contextWith(FIXTURES.officeTower)
  const codeOf = async (input: object, at = ctx) => {
    const envelope = await runOp(routeSolve, at, { propertyId: 'p', ...input })
    return envelope.ok ? 'ok' : envelope.error.code
  }
  assert.equal(await codeOf({ target: { spaceId: 'nope' }, payload: 'person' }), 'not_found')
  assert.equal(await codeOf({ target: { spaceId: 's5-east' }, payload: 'custom' }), 'invalid_input')
  assert.equal(await codeOf({ target: { spaceId: 's5-east' }, payload: 'custom', widthM: 0.5, heightM: 1 }), 'ok')
  const empty = contextWith({ ...FIXTURES.officeTower, storeys: FIXTURES.officeTower.storeys.map((storey) => ({ ...storey, spaces: [], openings: [] })) })
  assert.equal(await codeOf({ target: { spaceId: 's5-east' }, payload: 'person' }, empty), 'no_data')
})

test('a wheelchair with only a stair upstairs answers reachable: false', async () => {
  const envelope = await runOp(routeSolve, contextWith(FIXTURES.apartment), { propertyId: 'p', target: { spaceId: 'a1-unit-ne' }, payload: 'wheelchair' })
  assert.ok(envelope.ok)
  assert.equal(envelope.result.reachable, false)
  assert.equal(envelope.result.lengthM, null)
})

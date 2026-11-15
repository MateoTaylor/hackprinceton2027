import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { Property } from '../../../../shared/property.ts'
import type { FloorPlan } from '../../matterport.ts'
import type { ExtractFeature } from '../../vexcel.ts'
import { OpError } from '../op.ts'
import { buildBuilding, buildingCacheFile, capAssumptions, inferredShareOf, type BuildContext } from './build.ts'

const dataDir = await mkdtemp(join(tmpdir(), 'building-'))
after(() => rm(dataDir, { recursive: true, force: true }))

const DEG = 0.0002
const site = { lat: 10, lon: 20 }

// A 22 m square office block, 12 m tall, as Vexcel's extract returns it.
const block: ExtractFeature = {
  id: 'block',
  ring: [[site.lon, site.lat], [site.lon, site.lat + DEG], [site.lon + DEG, site.lat + DEG], [site.lon + DEG, site.lat], [site.lon, site.lat]],
  capturedAt: '2025-01-01',
  primary: true,
  attributes: { 'roof-characteristics.height': 12, 'roof-characteristics.elevation': 0 },
}

// A one-room scan, 8 by 5 m.
const plan: FloorPlan = {
  floors: [{
    id: 'f0',
    label: 'Main',
    sequence: 0,
    vertices: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 8, y: 0 }, { id: 'c', x: 8, y: 5 }, { id: 'd', x: 0, y: 5 }],
    edges: [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'a']].map((vertexIds, i) => ({ id: `e${i}`, type: 'wall', thickness: 0.1, vertexIds, openings: [] })),
  }],
  rooms: [{ id: 'r', label: 'Office', floorId: 'f0', boundaryEdgeIds: ['e0', 'e1', 'e2', 'e3'], holeEdgeIds: [], classifications: [], ceiling: { minHeight: 2.7, maxHeight: 2.7 } }],
}

const propertyOf = (id: string, scans: Property['scans'] = []): Property => ({
  id,
  kind: 'commercial',
  costarId: '1',
  name: 'Test block',
  address: 'Test',
  ...site,
  typeLabel: 'Office',
  facts: [],
  photoUrl: null,
  scans,
})

// A context whose Vexcel and Matterport count their calls, with `floorPlan` standing in for the
// Matterport client.
function contextOf(floorPlan: (modelId: string) => Promise<FloorPlan>) {
  const calls = { extract: 0, floorPlan: 0 }
  const ctx: BuildContext = {
    dataDir,
    buildingFacts: new Map(),
    vexcel: {
      extract: async () => {
        calls.extract++
        return [block]
      },
    },
    matterport: {
      floorPlan: (modelId) => {
        calls.floorPlan++
        return floorPlan(modelId)
      },
    },
  }
  return { ctx, calls }
}

test('a second build of a property reads the cache and calls nothing upstream', async () => {
  const { ctx, calls } = contextOf(async () => plan)
  const property = propertyOf('cached', [{ modelId: 'aaaaaaaaaaa', name: 'Floor 1' }])
  const first = await buildBuilding(ctx, property)
  assert.ok(first.building.storeys.length > 0)
  assert.ok(existsSync(buildingCacheFile(dataDir, property.id)))
  const before = { ...calls }
  assert.deepEqual(await buildBuilding(ctx, property), first)
  assert.deepEqual(calls, before)
})

test('a scan that fails upstream is reported unplaced and the building is not cached', async () => {
  const { ctx } = contextOf(async () => {
    throw new OpError('upstream', 'Matterport did not answer.', 'Try again.')
  })
  const property = propertyOf('flaky', [{ modelId: 'bbbbbbbbbbb', name: 'Floor 1' }])
  const detail = await buildBuilding(ctx, property)
  assert.equal(detail.unplacedScans.length, 1)
  assert.match(detail.unplacedScans[0].reason, /^upstream/)
  assert.equal(existsSync(buildingCacheFile(dataDir, property.id)), false)
})

test('a model that fails its checks is an internal error', async () => {
  const { ctx } = contextOf(async () => plan)
  await assert.rejects(buildBuilding(ctx, propertyOf('x'.repeat(65))), (error) => error instanceof OpError && error.code === 'internal')
})

test('the inferred-rooms sentences survive however many scan sentences come first', () => {
  const scans = Array.from({ length: 12 }, (_, i) => `A scan's suite number ${i} is read as storey ${i}.`)
  const inferred = ['Storeys 1-3 are generated as a office layout.', 'Furnishings are inferred.']
  const kept = capAssumptions([...scans, scans[0]], inferred)
  assert.equal(kept.length, 8)
  assert.ok(inferred.every((sentence) => kept.includes(sentence)))
  assert.deepEqual(kept.slice(0, 6), scans.slice(0, 6))
})

test('a building with no floor area has no inferred share', () => {
  assert.equal(inferredShareOf([]), 0)
})

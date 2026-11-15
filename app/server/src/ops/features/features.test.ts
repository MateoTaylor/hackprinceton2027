import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { Property } from '../../../../shared/property.ts'
import { createDiskCache } from '../../cache.ts'
import { createVexcel } from '../../vexcel.ts'
import { type OpContext, RESULT_MAX_CHARS, runOp } from '../op.ts'
import { groupAttributes } from './groups.ts'
import { featuresDetect, featuresGet } from './index.ts'

const PROPERTY: Property = {
  id: 'p1',
  kind: 'commercial',
  costarId: '1',
  name: 'Invented Tower',
  address: '1 Invented Way',
  lat: 10,
  lon: 20,
  typeLabel: 'Office',
  facts: [],
  photoUrl: null,
  scans: [],
}
const SQUARE = 'POLYGON((20 10,20.001 10,20.001 10.001,20 10.001,20 10))'

const roots: string[] = []
after(() => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))))

// A context whose Vexcel answers every request with `answer`: a JSON body, or a bare status.
async function contextWith(answer: object | number): Promise<OpContext> {
  const root = await mkdtemp(join(tmpdir(), 'propstar-features-'))
  roots.push(root)
  const fetch = async () =>
    typeof answer === 'number' ? new Response(null, { status: answer }) : Response.json(answer)
  return {
    properties: new Map([[PROPERTY.id, PROPERTY]]),
    vexcel: createVexcel({ apiKey: 'k', cache: createDiskCache(root), fetch }),
    matterport: null,
    buildingFacts: new Map(),
    dataDir: root,
    edit: async () => {
      throw new Error('features_get never calls the edit API')
    },
    call: async () => {
      throw new Error('features_get calls no other op')
    },
  }
}

const capture = (date: string, structure: Record<string, unknown>, parcel: Record<string, unknown> = {}) => ({
  properties: { 'metadata.ortho-date-estimate': date, ...parcel, structures: [{ 'footprint.wkt': SQUARE, 'primary-structure': true, ...structure }] },
})

test('the newest capture wins even when Vexcel lists it second', async () => {
  const ctx = await contextWith({
    features: [
      capture('2021-01-20', { 'roof-characteristics.height': 3 }),
      capture('2026-07-03', { 'roof-characteristics.height': 9 }, { 'pool.detected': false }),
    ],
  })
  const answer = await runOp(featuresGet, ctx, { propertyId: 'p1' }, { detail: true })
  assert.ok(answer.ok)
  assert.equal(answer.result.capturedAt, '2026-07-03')
  assert.equal(answer.result.source, 'vexcel')
  assert.deepEqual(answer.result.groups, [
    { group: 'pool', attributes: [{ key: 'pool.detected', value: false }] },
    { group: 'roof-characteristics', attributes: [{ key: 'roof-characteristics.height', value: 9 }] },
  ])
})

test('groupAttributes drops nulls, stray keys and empty groups, in group order with keys sorted', () => {
  const groups = groupAttributes({
    'vehicles.count': 2,
    'footprint.area': 120,
    'pool.total-area': null,
    'roof-objects.solar.count': 4,
    'roof-objects.chimney.count': 1,
  })
  assert.deepEqual(groups, [
    { group: 'roof-objects', attributes: [{ key: 'roof-objects.chimney.count', value: 1 }, { key: 'roof-objects.solar.count', value: 4 }] },
    { group: 'vehicles', attributes: [{ key: 'vehicles.count', value: 2 }] },
  ])
})

test('a point with only ungrouped attributes is no_data', async () => {
  const answer = await runOp(featuresGet, await contextWith({ features: [capture('2024-01-01', { 'footprint.area': 120 })] }), { propertyId: 'p1' })
  assert.ok(!answer.ok)
  assert.equal(answer.error.code, 'no_data')
})

test('a Vexcel failure is upstream with the status only', async () => {
  const answer = await runOp(featuresGet, await contextWith(500), { propertyId: 'p1' })
  assert.ok(!answer.ok)
  assert.equal(answer.error.code, 'upstream')
  assert.equal(answer.error.message, 'Vexcel answered 500.')
})

test('an unknown property is not_found', async () => {
  const answer = await runOp(featuresGet, await contextWith({ features: [] }), { propertyId: 'nope' })
  assert.ok(!answer.ok)
  assert.equal(answer.error.code, 'not_found')
})

test('200 attributes keep result under the cap and detail holds them all', async () => {
  const many = Object.fromEntries(Array.from({ length: 200 }, (_, n) => [`roof-defects.defect-${String(n).padStart(3, '0')}.confidence`, n / 7]))
  const answer = await runOp(featuresGet, await contextWith({ features: [capture('2025-05-05', many)] }), { propertyId: 'p1' }, { detail: true })
  assert.ok(answer.ok)
  assert.ok(JSON.stringify(answer.result).length <= RESULT_MAX_CHARS)
  assert.equal(answer.result.omittedCount, 160)
  assert.equal(answer.detail?.groups[0].attributes.length, 200)
})

test('features_detect counts each label asked for, zeros included', async () => {
  const box = 'POLYGON((20 10,20.0001 10,20.0001 10.0001,20 10))'
  const found = (label: string, confidence: number) => ({ properties: { label, detections: [{ imageId: 'i', bbox: box, confidence }] } })
  const ctx = await contextWith({ features: [found('car', 0.9), found('car', 0.7), found('car', 0.95)] })
  const answer = await runOp(featuresDetect, ctx, { propertyId: 'p1', labels: ['car', 'solar panel'] }, { detail: true })
  assert.ok(answer.ok)
  assert.deepEqual(answer.result.labels, [
    { label: 'car', count: 3, maxConfidence: 0.95 },
    { label: 'solar panel', count: 0, maxConfidence: null },
  ])
  assert.equal(answer.result.radiusM, 40)
  assert.equal(answer.detail?.detections.length, 3)
})

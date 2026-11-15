import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Property } from '../../../../shared/property.ts'
import type { ServerEvent } from '../../../../shared/view.ts'
import { createDiskCache } from '../../cache.ts'
import { createVexcel } from '../../vexcel.ts'
import { createViewStore } from '../../view/store.ts'
import { RESULT_MAX_CHARS, runOp, type OpContext } from '../op.ts'
import { createViewOps } from './index.ts'

const place = (n: number, kind: Property['kind'] = 'commercial', scans: Property['scans'] = []): Property => ({
  id: `${kind}-${n}`, kind, costarId: String(n), name: `P${n}`, address: `${n} Main St`, lat: 34 + n / 1000, lon: -118 - n / 1000,
  typeLabel: 'Office', facts: [], photoUrl: null, scans,
})

const properties = [place(1, 'commercial', [{ modelId: 'm1', name: 'Lobby' }, { modelId: 'm2', name: 'Roof' }]), place(2, 'residential'), ...Array.from({ length: 250 }, (_, i) => place(i + 10))]

const setup = () => {
  const store = createViewStore()
  const unused = '/nonexistent-propstar-view-test'
  const ctx: OpContext = {
    properties: new Map(properties.map((p) => [p.id, p])),
    vexcel: createVexcel({ apiKey: 'k', cache: createDiskCache(unused) }),
    matterport: null,
    buildingFacts: new Map(),
    dataDir: unused,
    edit: async () => new Response(null, { status: 503 }),
    call: async () => {
      throw new Error('no view op calls another op')
    },
  }
  const ops = new Map(createViewOps(store).map((op) => [op.name, op]))
  const run = async (name: string, input: object, detail = false) => {
    const op = ops.get(name)
    assert.ok(op, name)
    return runOp(op, ctx, input, { detail })
  }
  const ok = async (name: string, input: object = {}) => {
    const answer = await run(name, input)
    assert.ok(answer.ok, `${name} failed: ${JSON.stringify(answer)}`)
    return answer.result as Record<string, unknown>
  }
  const code = async (name: string, input: object) => {
    const answer = await run(name, input)
    assert.ok(!answer.ok, `${name} should fail`)
    return answer.error
  }
  return { store, ok, code, run }
}

test('the five ops are view ops except view_get, which reads, and each summary fits a tool description', () => {
  for (const op of createViewOps(createViewStore())) assert.ok(op.summary.length <= 160, op.name)
  assert.deepEqual(
    createViewOps(createViewStore()).map((op) => [op.name, op.effect]),
    [
      ['view_get', 'read'],
      ['view_open', 'view'],
      ['view_frame', 'view'],
      ['view_camera', 'view'],
      ['view_highlight', 'view'],
    ],
  )
})

test('view_open opens a card, a fly-through or a tool and says when no tab is open', async () => {
  const { store, ok, code } = setup()
  const card = await ok('view_open', { propertyId: 'commercial-1', panel: 'card' })
  assert.deepEqual(card.screen, { kind: 'selected', propertyId: 'commercial-1' })
  assert.equal(card.attached, 0)
  assert.match(String(card.assumptions), /No browser tab is open/)
  assert.equal(store.get().version, 1)

  assert.deepEqual((await ok('view_open', { propertyId: 'commercial-1', panel: 'flythrough' })).screen, { kind: 'flythrough', propertyId: 'commercial-1', modelId: 'm1' })
  assert.deepEqual((await ok('view_open', { propertyId: 'commercial-1', panel: 'flythrough', modelId: 'm2' })).screen, { kind: 'flythrough', propertyId: 'commercial-1', modelId: 'm2' })
  assert.deepEqual((await ok('view_open', { propertyId: 'commercial-1', panel: 'route' })).screen, { kind: 'tool', propertyId: 'commercial-1', tool: 'route' })

  assert.equal((await code('view_open', { propertyId: 'nope', panel: 'card' })).code, 'not_found')
  assert.equal((await code('view_open', { propertyId: 'residential-2', panel: 'flythrough' })).code, 'no_data')
  assert.equal((await code('view_open', { propertyId: 'commercial-1', panel: 'flythrough', modelId: 'zz' })).code, 'not_found')
  assert.equal((await code('view_open', { propertyId: 'residential-2', panel: 'signage' })).code, 'invalid_input')
  assert.equal((await code('view_open', { propertyId: 'commercial-1', panel: 'area' })).code, 'invalid_input')
  assert.equal(store.get().version, 4)
})

test('view_frame returns to the map and sends a fit around the given properties, or all of them', async () => {
  const { store, ok, code } = setup()
  const moves: unknown[] = []
  store.subscribe((e: ServerEvent) => e.type === 'view' && moves.push(e.move))
  store.apply({ screen: { kind: 'selected', propertyId: 'commercial-1' } }, 'tab')

  assert.deepEqual((await ok('view_frame', { propertyIds: ['commercial-1', 'residential-2'] })).screen, { kind: 'browse' })
  await ok('view_frame')
  assert.deepEqual(moves[1], { fit: { west: -118.002, south: 34.001, east: -118.001, north: 34.002 } })
  assert.deepEqual(moves[2], { fit: { west: -118.259, south: 34.001, east: -118.001, north: 34.259 } })
  assert.equal((await code('view_frame', { propertyIds: ['commercial-1', 'ghost'] })).message, 'No property has the id "ghost".')
})

test('view_camera fills a missing value from the reported camera and needs one first', async () => {
  const { store, ok, code } = setup()
  const moves: unknown[] = []
  store.subscribe((e: ServerEvent) => e.type === 'view' && moves.push(e.move))

  assert.equal((await code('view_camera', { zoom: 14 })).code, 'not_ready')
  assert.equal((await code('view_camera', { zoom: 30 })).code, 'invalid_input')
  assert.equal((await code('view_camera', {})).code, 'invalid_input')
  await ok('view_camera', { lat: 34, lon: -118, zoom: 12 })
  store.apply({ camera: { lat: 34, lon: -118, zoom: 12 } }, 'tab')
  await ok('view_camera', { zoom: 16 })
  assert.deepEqual(moves, [{ lat: 34, lon: -118, zoom: 12 }, undefined, { lat: 34, lon: -118, zoom: 16 }])
})

test('view_highlight replaces, upserts and clears, and caps the list at 200', async () => {
  const { store, ok, code } = setup()
  await ok('view_highlight', { mode: 'replace', items: [{ propertyId: 'commercial-1', score: 40 }, { propertyId: 'residential-2', score: null }] })
  const added = await ok('view_highlight', { mode: 'add', items: [{ propertyId: 'commercial-1', score: 90, note: 'Ramp at the door' }, { propertyId: 'commercial-10', score: 70 }] })
  assert.equal(added.highlightCount, 3)
  assert.deepEqual(store.get().highlights[0], { propertyId: 'commercial-1', score: 90, note: 'Ramp at the door' })

  const ghost = await code('view_highlight', { mode: 'add', items: [{ propertyId: 'ghost', score: 1 }] })
  assert.equal(ghost.code, 'not_found')
  assert.match(ghost.message, /ghost/)
  assert.equal((await code('view_highlight', { mode: 'add', items: [{ propertyId: 'commercial-1', score: 101 }] })).code, 'invalid_input')
  assert.equal((await code('view_highlight', { mode: 'add', items: [{ propertyId: 'commercial-1', score: 1, note: 'x'.repeat(81) }] })).code, 'invalid_input')

  const many = properties.slice(2, 202).map((p) => ({ propertyId: p.id, score: 50 }))
  assert.equal((await code('view_highlight', { mode: 'add', items: many })).code, 'invalid_input')
  assert.equal((await ok('view_highlight', { mode: 'clear' })).highlightCount, 0)
})

test('view_get fits 200 highlights, lists the first 20 and counts what is in bounds', async () => {
  const { store, ok, run } = setup()
  assert.equal((await ok('view_get')).inView, null)
  const many = properties.slice(2, 202).map((p) => ({ propertyId: p.id, score: 55, note: 'n'.repeat(80) }))
  await ok('view_highlight', { mode: 'replace', items: many })
  store.apply({ bounds: { west: -118.0025, south: 34, east: -118, north: 34.0025 } }, 'tab')

  const answer = await run('view_get', {}, true)
  assert.ok(answer.ok)
  assert.ok(JSON.stringify(answer.result).length <= RESULT_MAX_CHARS)
  const result = answer.result as { highlightCount: number; highlights: unknown[]; inView: { count: number; propertyIds: string[] } }
  assert.equal(result.highlightCount, 200)
  assert.equal(result.highlights.length, 20)
  assert.deepEqual(result.inView, { count: 2, propertyIds: ['commercial-1', 'residential-2'] })
  assert.equal((answer.detail as { highlights: unknown[] }).highlights.length, 200)
})

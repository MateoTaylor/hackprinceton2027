import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ServerEvent } from '../../../shared/view.ts'
import { createApp } from '../app.ts'
import { z } from 'zod'
import { createDiskCache } from '../cache.ts'
import { defineOp, type Op } from '../ops/op.ts'
import { createVexcel } from '../vexcel.ts'
import { createViewStore } from './store.ts'

test('apply adds one to version per change and sends events in order to every listener', () => {
  const store = createViewStore()
  const a: ServerEvent[] = []
  const b: ServerEvent[] = []
  store.subscribe((e) => a.push(e))
  const stop = store.subscribe((e) => b.push(e))
  assert.equal(store.attached(), 2)

  store.apply({ screen: { kind: 'selected', propertyId: 'p1' } }, 'op')
  stop()
  assert.equal(store.attached(), 1)
  store.apply({ highlights: [{ propertyId: 'p1', score: 80 }] }, 'tab-1', { lat: 1, lon: 2, zoom: 3 })
  store.publishWrite({ op: 'signage_place', by: 'tab-1', propertyId: 'p1', result: {} })

  assert.equal(store.get().version, 2)
  assert.deepEqual(store.get().screen, { kind: 'selected', propertyId: 'p1' })
  assert.deepEqual(
    a.map((e) => (e.type === 'view' ? [e.type, e.view.version, e.by, e.move] : [e.type, e.op, e.by])),
    [
      ['view', 1, 'op', undefined],
      ['view', 2, 'tab-1', { lat: 1, lon: 2, zoom: 3 }],
      ['write', 'signage_place', 'tab-1'],
    ],
  )
  assert.equal(b.length, 1)
})

test('a listener that throws is dropped and the others still hear', () => {
  const store = createViewStore()
  const heard: number[] = []
  store.subscribe(() => {
    throw new Error('closed')
  })
  store.subscribe((e) => e.type === 'view' && heard.push(e.view.version))
  store.apply({}, 'op')
  store.apply({}, 'op')
  assert.deepEqual(heard, [1, 2])
  assert.equal(store.attached(), 1)
})

const appWith = (ops?: Op[]) => {
  const view = createViewStore()
  const unused = createDiskCache('/nonexistent-propstar-view-test')
  const app = createApp({
    view,
    ...(ops && { ops }),
    base: {
      properties: new Map(),
      vexcel: createVexcel({ apiKey: 'k', cache: unused }),
      matterport: null,
      buildingFacts: new Map(),
      dataDir: '/nonexistent-propstar-view-test',
      edit: async () => new Response(null, { status: 503 }),
    },
  })
  return { app, view }
}

test('PUT /api/view applies a report by the tab id and refuses a bad body', async () => {
  const { app, view } = appWith()
  const put = (body: unknown, client?: string) =>
    app.request('/api/view', { method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...(client && { 'x-propstar-client': client }) } })
  const events: ServerEvent[] = []
  view.subscribe((e) => events.push(e))

  const ok = await put({ camera: { lat: 34, lon: -118, zoom: 12 }, bounds: { west: -119, south: 33, east: -117, north: 35 } }, 'tab-1')
  assert.equal(ok.status, 200)
  assert.deepEqual(await ok.json(), { version: 1 })
  assert.deepEqual(view.get().camera, { lat: 34, lon: -118, zoom: 12 })
  assert.equal(events[0].by, 'tab-1')

  assert.equal((await put({ camera: { lat: 400, lon: 0, zoom: 1 } })).status, 400)
  assert.equal((await put({ highlights: [] })).status, 400)
  assert.equal((await put({ screen: { kind: 'selected' } })).status, 400)
  assert.equal(view.get().version, 1)

  await put({ filter: { kind: 'commercial', type: null, sort: 'name', savedOnly: false } }, 'bad id with spaces')
  assert.equal(events[1].by, 'unknown')
})

test('GET /api/events sends the current view first, then each change', async () => {
  const { app, view } = appWith()
  view.apply({ screen: { kind: 'selected', propertyId: 'p1' } }, 'op')
  const res = await app.request('/api/events')
  assert.equal(res.headers.get('content-type'), 'text/event-stream')
  assert.ok(res.body)
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  let text = ''
  const until = async (n: number) => {
    while ((text.match(/^data: /gm) ?? []).length < n) text += (await reader.read()).value ?? ''
  }
  await until(1)
  assert.equal(view.attached(), 1)
  view.apply({ highlights: [{ propertyId: 'p1', score: null }] }, 'op')
  await until(2)
  await reader.cancel()
  const events = text.match(/^data: (.*)$/gm)?.map((line) => JSON.parse(line.slice(6)))
  assert.deepEqual(
    events?.map((e) => [e.by, e.view.version]),
    [
      ['server', 1],
      ['op', 2],
    ],
  )
})

test('a write op that answers ok publishes a write event with its caller, property and result, and a read op does not', async () => {
  const op = (name: string, effect: Op['effect']) =>
    defineOp({ name, summary: 'Answers ok.', effect, input: z.object({ propertyId: z.string() }), output: z.object({ saved: z.boolean() }) })(async () => ({ result: { saved: true } }))
  const { app, view } = appWith([op('thing_save', 'write'), op('thing_get', 'read')])
  const events: ServerEvent[] = []
  view.subscribe((e) => events.push(e))
  const post = (name: string) => app.request(`/api/ops/${name}`, { method: 'POST', body: '{"propertyId":"p7"}', headers: { 'content-type': 'application/json', 'x-propstar-client': 'tab-9' } })
  assert.equal((await post('thing_get')).status, 200)
  assert.equal((await post('thing_save')).status, 200)
  assert.deepEqual(events, [{ type: 'write', op: 'thing_save', by: 'tab-9', propertyId: 'p7', result: { saved: true } }])
})

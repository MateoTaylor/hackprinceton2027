import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ViewReport } from '../../shared/view'
import { createReporter, INITIAL_VIEW, onViewEvent } from './view.ts'

const start = { view: INITIAL_VIEW, move: null }
const opened = { ...INITIAL_VIEW, version: 3, screen: { kind: 'selected', propertyId: 'commercial-1' } as const }

test('a view event by this tab is dropped and one by another writer is adopted with its move', () => {
  assert.equal(onViewEvent(start, { type: 'view', view: opened, by: 'me' }, 'me'), start)

  const next = onViewEvent(start, { type: 'view', view: opened, by: 'op', move: { lat: 34, lon: -118, zoom: 15 } }, 'me')
  assert.equal(next.view, opened)
  assert.deepEqual(next.move, { seq: 1, request: { lat: 34, lon: -118, zoom: 15 } })

  const after = onViewEvent(next, { type: 'view', view: { ...opened, version: 4 }, by: 'server' }, 'me')
  assert.equal(after.view.version, 4)
  assert.equal(after.move, next.move, 'an event without a move keeps the last request, so it is not applied again')
  assert.equal(onViewEvent(after, { type: 'write', op: 'signage_place', by: 'op', propertyId: 'p1', result: null }, 'me'), after)
})

test('two reports inside 250 ms send one merged request', async () => {
  const sent: ViewReport[] = []
  const reporter = createReporter((r) => sent.push(r), 250)
  reporter.report({ camera: { lat: 1, lon: 2, zoom: 3 } })
  reporter.report({ bounds: { west: 0, south: 0, east: 1, north: 1 } })
  assert.equal(sent.length, 0)
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.deepEqual(sent, [{ camera: { lat: 1, lon: 2, zoom: 3 }, bounds: { west: 0, south: 0, east: 1, north: 1 } }])
  reporter.report({ camera: { lat: 5, lon: 6, zoom: 7 } })
  reporter.flush()
  assert.equal(sent.length, 2)
})

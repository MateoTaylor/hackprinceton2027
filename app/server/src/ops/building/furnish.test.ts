import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Opening, Ring, Space } from '../../model/building.ts'
import { ringArea } from '../../model/geo.ts'
import { intersectRings } from './clip.ts'
import { clearanceOf, footprintOf, furnishSpace } from './furnish.ts'

const rect = (x0: number, y0: number, x1: number, y1: number): Ring => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
const space = (label: string, ring: Ring, source: Space['source'] = 'inferred'): Space => ({ id: 's', label, ring, source, confidence: 0.3 })
const door: Opening = { id: 'd', kind: 'door', at: [3, 0], widthM: 0.9, heightM: 2.1, bearingDeg: 0, spaceIds: ['x', 's'], source: 'inferred', confidence: 0.25 }

const insideShare = (ring: Ring, room: Ring) => intersectRings([ring], [room]).reduce((sum, part) => sum + ringArea(part), 0) / ringArea(ring)

test('furnishings stay inside their space, clear of doors and of each other', () => {
  const room = rect(0, 0, 8, 6)
  const items = furnishSpace(space('Office', room), [door], 7)
  assert.ok(items.length >= 4)
  const rings = items.map(footprintOf)
  for (const ring of rings) {
    assert.ok(insideShare(ring, room) > 0.99)
    assert.equal(intersectRings([ring], [clearanceOf(door)]).length, 0)
  }
  rings.forEach((a, i) => rings.slice(i + 1).forEach((b) => assert.equal(intersectRings([a], [b]).length, 0)))
  assert.ok(items.every(({ source, confidence }) => source === 'inferred' && confidence === 0.15))
})

test('the same seed gives the same furnishings', () => {
  const room = space('Conference room', rect(0, 0, 7, 5))
  assert.deepEqual(furnishSpace(room, [], 3), furnishSpace(room, [], 3))
})

test('a scanned space gets a higher confidence and an unknown label stays empty', () => {
  assert.ok(furnishSpace(space('Bedroom', rect(0, 0, 4, 4), 'scan'), [], 1).every(({ confidence }) => confidence === 0.3))
  assert.deepEqual(furnishSpace(space('Corridor', rect(0, 0, 20, 2)), [], 1), [])
})

test('a warehouse floor gets rows of racks and at most 40 items', () => {
  const items = furnishSpace(space('Warehouse floor', rect(0, 0, 60, 40)), [], 1)
  assert.ok(items.filter(({ kind }) => kind === 'rack').length > 10)
  assert.ok(items.length <= 40)
})

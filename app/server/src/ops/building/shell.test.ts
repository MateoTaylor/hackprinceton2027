import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { LngLat } from '../../../../shared/api.ts'
import { ringArea } from '../../model/geo.ts'
import type { ExtractFeature } from '../../vexcel.ts'
import { OpError } from '../op.ts'
import { buildShell, pickCapture } from './shell.ts'

const site = { lat: 10, lon: 20 }
const DEG = 0.0001

// A closed clockwise square of `size` steps of DEG, south-west corner `east` and `north` steps
// from the site, the way Vexcel draws a footprint.
const square = (east: number, north: number, size = 2): LngLat[] => {
  const [w, s] = [site.lon + east * DEG, site.lat + north * DEG]
  const [e, n] = [w + size * DEG, s + size * DEG]
  return [[w, s], [w, n], [e, n], [e, s], [w, s]]
}

const structure = (id: string, capturedAt: string, attrs: { primary?: boolean; heightM?: number; elevationM?: number; east?: number }): ExtractFeature => ({
  id,
  ring: square(attrs.east ?? 0, 0),
  capturedAt,
  primary: attrs.primary ?? false,
  attributes: {
    ...(attrs.heightM !== undefined && { 'roof-characteristics.height': attrs.heightM }),
    ...(attrs.elevationM !== undefined && { 'roof-characteristics.elevation': attrs.elevationM }),
  },
})

test('the newest capture with a primary structure wins', () => {
  const older = structure('a', '2023-04-01', { primary: true, heightM: 40 })
  const newer = structure('b', '2025-09-12', { primary: true, heightM: 42 })
  assert.deepEqual(pickCapture([older, newer]), [newer])
})

test('a 2 m shed never becomes the primary volume', () => {
  const tower = structure('tower', '2023-04-01', { primary: true, heightM: 40 })
  const shed = structure('shed', '2025-09-12', { primary: true, heightM: 2 })
  assert.deepEqual(pickCapture([tower, shed]), [tower])
  assert.throws(() => pickCapture([shed]), (error) => error instanceof OpError && error.code === 'no_data')
})

test('the shell takes its height and ground from the primary structure', () => {
  const tower = structure('tower', '2025-09-12', { primary: true, heightM: 40, elevationM: 52 })
  const podium = structure('podium', '2025-09-12', { heightM: 8, east: 3 })
  const { origin, shell } = buildShell(site, [tower, podium], [])
  assert.equal(origin.groundElevationM, 12)
  assert.equal(shell.heightM, 40)
  assert.deepEqual(
    shell.volumes.map(({ primary, baseM, topM, source }) => ({ primary, baseM, topM, source })),
    [
      { primary: true, baseM: 0, topM: 40, source: 'vexcel' },
      { primary: false, baseM: 0, topM: 8, source: 'vexcel' },
    ],
  )
})

test('a neighbour with no height is 6 m tall', () => {
  const tower = structure('tower', '2025-09-12', { primary: true, heightM: 40, elevationM: 52 })
  const neighbours = [structure('n1', '2025-09-12', { east: 5, heightM: 15 }), structure('n2', '2025-09-12', { east: 9 })]
  const { context, assumptions } = buildShell(site, [tower], neighbours)
  assert.deepEqual(context.map(({ heightM }) => heightM), [15, 6])
  assert.ok(assumptions.some((sentence) => sentence.startsWith('1 of 2 neighbours')))
})

test('older captures of the building and of a neighbour are dropped', () => {
  const tower = structure('tower', '2025-09-12', { primary: true, heightM: 40, elevationM: 52 })
  const oldTower = { ...structure('old-tower', '2021-01-20', { heightM: 39 }), ring: square(0.2, 0.1) }
  const neighbour = structure('n1', '2025-09-12', { east: 5, heightM: 15 })
  const oldNeighbour = { ...structure('old-n1', '2023-04-01', { heightM: 14 }), ring: square(5.1, 0.2) }
  const { context } = buildShell(site, [tower], [oldNeighbour, tower, oldTower, neighbour])
  assert.deepEqual(context.map(({ heightM }) => heightM), [15])
})

test('a neighbour tower on its podium in the same capture keeps both', () => {
  const tower = structure('tower', '2025-09-12', { primary: true, heightM: 40, elevationM: 52 })
  const podium = { ...structure('podium', '2025-09-12', { heightM: 8 }), ring: square(5, 0, 4) }
  const onPodium = { ...structure('on-podium', '2025-09-12', { heightM: 30 }), ring: square(6, 1) }
  const { context } = buildShell(site, [tower], [podium, onPodium])
  assert.deepEqual(context.map(({ heightM }) => heightM), [8, 30])
})

test('every ring comes out counter-clockwise and open', () => {
  const tower = structure('tower', '2025-09-12', { primary: true, heightM: 40, elevationM: 52 })
  const { shell, context } = buildShell(site, [tower], [structure('n1', '2025-09-12', { east: 5, heightM: 15 })])
  for (const ring of [...shell.volumes.map(({ ring }) => ring), ...context.map(({ ring }) => ring)]) {
    assert.equal(ring.length, 4)
    assert.ok(ringArea(ring) > 0)
  }
})

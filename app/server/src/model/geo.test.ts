import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { LngLat } from '../../../shared/api.ts'
import type { Point, Ring } from './building.ts'
import { bearingDeg, distanceM, orientCcw, pointInRing, ringArea, ringBounds, ringCentroid, toEnu, toLatLon } from './geo.ts'

const ORIGINS = [
  { lat: 29.75, lon: -95.36 },
  { lat: 34.05, lon: -118.3 },
]
const COMPASS = Array.from({ length: 16 }, (_, n) => (n * Math.PI) / 8)

const A = 6378137
const E2 = (1 / 298.257223563) * (2 - 1 / 298.257223563)

function tangentPlane(origin: { lat: number; lon: number }, [lon, lat]: LngLat): Point {
  const ecef = (latDeg: number, lonDeg: number) => {
    const [phi, lambda] = [(latDeg * Math.PI) / 180, (lonDeg * Math.PI) / 180]
    const n = A / Math.sqrt(1 - E2 * Math.sin(phi) ** 2)
    return [n * Math.cos(phi) * Math.cos(lambda), n * Math.cos(phi) * Math.sin(lambda), n * (1 - E2) * Math.sin(phi)]
  }
  const [x0, y0, z0] = ecef(origin.lat, origin.lon)
  const [x, y, z] = ecef(lat, lon)
  const [dx, dy, dz] = [x - x0, y - y0, z - z0]
  const [phi, lambda] = [(origin.lat * Math.PI) / 180, (origin.lon * Math.PI) / 180]
  return [
    -Math.sin(lambda) * dx + Math.cos(lambda) * dy,
    -Math.sin(phi) * Math.cos(lambda) * dx - Math.sin(phi) * Math.sin(lambda) * dy + Math.cos(phi) * dz,
  ]
}

const square: Ring = [
  [0, 0],
  [4, 0],
  [4, 4],
  [0, 4],
]

test('toLatLon undoes toEnu within 0.01 m at 500 m', () => {
  for (const origin of ORIGINS) {
    for (const angle of COMPASS) {
      const point: Point = [500 * Math.sin(angle), 500 * Math.cos(angle)]
      assert.ok(distanceM(toEnu(origin, toLatLon(origin, point)), point) < 0.01)
      const [lon, lat] = toLatLon(origin, point)
      const [backLon, backLat] = toLatLon(origin, toEnu(origin, [lon, lat]))
      assert.ok(Math.abs(backLon - lon) < 1e-9 && Math.abs(backLat - lat) < 1e-9)
    }
  }
})

test('toEnu stays within 6 cm of the tangent plane at 1 km', () => {
  for (const origin of ORIGINS) {
    for (const angle of COMPASS) {
      const position = toLatLon(origin, [1000 * Math.sin(angle), 1000 * Math.cos(angle)])
      assert.ok(distanceM(toEnu(origin, position), tangentPlane(origin, position)) < 0.06)
    }
  }
})

test('ringArea is positive for a counter-clockwise ring and negative for a clockwise one', () => {
  assert.equal(ringArea(square), 16)
  assert.equal(ringArea(square.toReversed()), -16)
})

test('ringCentroid weights by area', () => {
  const ell: Ring = [
    [0, 0],
    [4, 0],
    [4, 1],
    [1, 1],
    [1, 4],
    [0, 4],
  ]
  const [x, y] = ringCentroid(ell)
  assert.ok(Math.abs(x - 19 / 14) < 1e-12 && Math.abs(y - 19 / 14) < 1e-12)
  assert.deepEqual(ringCentroid(square), [2, 2])
})

test('ringBounds is the box around a ring', () => {
  assert.deepEqual(ringBounds(square), { minX: 0, minY: 0, maxX: 4, maxY: 4 })
})

test('orientCcw turns a closed clockwise ring into an open counter-clockwise one', () => {
  const clockwise = square.toReversed()
  const ring = orientCcw([...clockwise, clockwise[0]])
  assert.equal(ring.length, 4)
  assert.equal(ringArea(ring), 16)
  assert.equal(orientCcw(square), square)
})

test('pointInRing takes the edge within its tolerance', () => {
  assert.equal(pointInRing([2, 2], square), true)
  assert.equal(pointInRing([5, 2], square), false)
  assert.equal(pointInRing([4.04, 2], square, 0.05), true)
  assert.equal(pointInRing([4.06, 2], square, 0.05), false)
})

test('bearingDeg runs clockwise from north in 0 up to 360', () => {
  const targets: Point[] = [
    [0, 1],
    [1, 0],
    [0, -1],
    [-1, 0],
  ]
  assert.deepEqual(
    targets.map((to) => bearingDeg([0, 0], to)),
    [0, 90, 180, 270],
  )
})

test('distanceM is the straight line between two points', () => {
  assert.equal(distanceM([0, 0], [3, 4]), 5)
})

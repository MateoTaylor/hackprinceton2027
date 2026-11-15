import assert from 'node:assert/strict'
import { test } from 'node:test'
import { toLatLon } from '../../model/geo.ts'
import type { ObliqueCamera } from '../../obliquePose.ts'
import { utmToLngLat } from '../../obliquePose.ts'
import { cameraInFrame } from './camera.ts'
import { chooseLift } from './lift.ts'
import { misfit, shellWalls, signCorners, wallFacing } from './walls.ts'

const need = { heightM: 5, outreachM: 0, ground: 'paved', overObstacle: false } as const

test('chooseLift names the smallest class that meets the need', () => {
  assert.equal(chooseLift(need)?.lift.class, 'slab_scissor')
  assert.equal(chooseLift({ ...need, ground: 'unpaved' })?.lift.class, 'rough_terrain_scissor')
  assert.equal(chooseLift({ ...need, heightM: 10, overObstacle: true })?.lift.class, 'articulating_boom')
  assert.equal(chooseLift({ ...need, outreachM: 20 })?.lift.class, 'telescopic_boom')
})

test('chooseLift offers at most three alternatives, each at least as tall as the need', () => {
  const chosen = chooseLift(need)
  assert.ok(chosen && chosen.alternatives.length === 3)
  assert.ok(chosen.alternatives.every(({ workingHeightM }) => workingHeightM >= need.heightM))
})

test('chooseLift is null when nothing reaches', () => {
  assert.equal(chooseLift({ ...need, heightM: 200 }), null)
})

type Vec3 = [number, number, number]
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = ([a, b, c]: Vec3, [d, e, f]: Vec3): Vec3 => [b * f - c * e, c * d - a * f, a * e - b * d]
const unit = (v: Vec3): Vec3 => v.map((x) => x / Math.hypot(...v)) as Vec3
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

// An invented aerial camera 3 km up and 3 km south of a building, looking at it 45 degrees down,
// with image x to the right and y down. Its frame's ground outline is what Vexcel would write.
const origin = { lat: 34.05, lon: -118.25, groundElevationM: 40 }
const centre: Vec3 = [-150, -3000, 3100]
const [frameW, frameH, focalPx, planeZ] = [12000, 18000, 14000, 1.5]
const forward = unit(sub([0, 0, 0], centre))
const right = unit(cross(forward, [0, 0, 1]))
const down = cross(forward, right)
const truePixel = (point: Vec3): [number, number] => {
  const q = sub(point, centre)
  const [x, y, z] = [dot(right, q), dot(down, q), dot(forward, q)]
  return [(focalPx * x) / z + frameW / 2, (focalPx * y) / z + frameH / 2]
}
const onGround = ([u, v]: [number, number]) => {
  const ray = [0, 1, 2].map((i) => right[i] * ((u - frameW / 2) / focalPx) + down[i] * ((v - frameH / 2) / focalPx) + forward[i]) as Vec3
  const t = (planeZ - centre[2]) / ray[2]
  return toLatLon(origin, [centre[0] + t * ray[0], centre[1] + t * ray[1]])
}
const crop = { x: 5200, y: 7900, width: 2400, height: 1900 }
const xmp: ObliqueCamera = {
  frame: { width: frameW, height: frameH },
  crop,
  footprint: ([[0, 0], [frameW, 0], [frameW, frameH], [0, frameH]] as [number, number][]).map(onGround),
  groundZ: origin.groundElevationM + planeZ,
  cameraAt: toLatLon(origin, [centre[0], centre[1]]),
  cameraZ: origin.groundElevationM + centre[2],
}

test('utmToLngLat puts the centre of zone 11 north where it belongs', () => {
  const [lon, lat] = utmToLngLat(500_000, 3_762_155.8, 11, true)
  assert.ok(Math.abs(lon + 117) < 1e-9, `lon is ${lon}`)
  assert.ok(Math.abs(lat - 34) < 1e-5, `lat is ${lat}`)
})

test('cameraInFrame projects through the measured camera to the true pixels', () => {
  const camera = cameraInFrame(xmp, origin)
  assert.ok(camera)
  assert.equal(camera.widthPx, crop.width)
  camera.centreM.forEach((value, i) => assert.ok(Math.abs(value - centre[i]) < 1, `centre axis ${i} is ${value}`))
  const m = camera.matrix
  for (const point of [[0, 0, 0], [20, -15, 0], [20, -15, 55], [-30, 10, 12]] satisfies Vec3[]) {
    const w = m[8] * point[0] + m[9] * point[1] + m[10] * point[2] + m[11]
    const seen = [0, 1].map((row) => (m[row * 4] * point[0] + m[row * 4 + 1] * point[1] + m[row * 4 + 2] * point[2] + m[row * 4 + 3]) / w)
    const [u, v] = truePixel(point)
    assert.ok(Math.hypot(seen[0] - (u - crop.x), seen[1] - (v - crop.y)) < 0.5, `point ${point} lands ${seen} not ${[u - crop.x, v - crop.y]}`)
  }
})

test('cameraInFrame refuses a degenerate outline', () => {
  const corner = xmp.footprint[0]
  assert.equal(cameraInFrame({ ...xmp, footprint: [corner, corner, corner, corner] }, origin), null)
})

// A 10 m by 20 m box, counter-clockwise from its south-west corner, with a 4 m podium.
const box = { id: 'tower', ring: [[0, 0], [10, 0], [10, 20], [0, 20]] satisfies [number, number][], baseM: 0, topM: 30, primary: true, source: 'vexcel', confidence: 0.8 } as const
const podium = { ...box, id: 'podium', ring: [[10, 0], [16, 0], [16, 8], [10, 8]] satisfies [number, number][], topM: 4, primary: false }
const walls = shellWalls([box, podium])

test('shellWalls numbers every edge and faces it outward', () => {
  assert.equal(walls.length, 8)
  assert.deepEqual(walls.slice(0, 4).map(({ facingDeg }) => facingDeg), [180, 90, 0, 270])
  assert.deepEqual(walls.map(({ lengthM }) => lengthM), [10, 20, 10, 20, 6, 8, 6, 8])
  assert.equal(walls[5].volumeId, 'podium')
  assert.equal(walls[5].topM, 4)
})

test('wallFacing picks the longest wall within 45 degrees that fits', () => {
  assert.equal(wallFacing(walls, 100, { widthM: 3, heightM: 1 })?.index, 1)
  assert.equal(wallFacing(walls, 170, { widthM: 3, heightM: 1 })?.index, 0)
  assert.equal(wallFacing(walls, 90, { widthM: 25, heightM: 1 }), undefined)
})

test('misfit names the range that would fit', () => {
  const sign = { alongM: 5, bottomM: 3, sizeM: { widthM: 4, heightM: 1 } }
  assert.equal(misfit(walls[0], sign), null)
  assert.match(misfit(walls[0], { ...sign, alongM: 9 }) ?? '', /from 2 to 8/)
  assert.match(misfit(walls[5], { ...sign, bottomM: 3.5 }) ?? '', /bottomM must be from 0 to 3/)
  assert.match(misfit(walls[4], { ...sign, sizeM: { widthM: 7, heightM: 1 } }) ?? '', /too short/)
})

test('signCorners spans the sign along its wall, left to right as seen from outside', () => {
  // The east face runs north from [10, 0], so from outside the start corner is on the left.
  assert.deepEqual(signCorners(walls[1], { alongM: 10, bottomM: 3, sizeM: { widthM: 4, heightM: 2 } }), [
    [10, 8, 3],
    [10, 12, 3],
    [10, 12, 5],
    [10, 8, 5],
  ])
})

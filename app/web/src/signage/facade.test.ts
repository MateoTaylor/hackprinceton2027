import assert from 'node:assert/strict'
import { test } from 'node:test'
import { facesCamera, fitOnWall, formatLength, hitWall, project, signCorners, type Camera, type Vec3, type Wall } from './facade.ts'

// An invented camera 300 m south of and 300 m above the origin, looking at it, with image x to
// the right and y down.
const centreM: Vec3 = [0, -300, 300]
const f = 2000
const [cx, cy] = [1000, 800]
const forward: Vec3 = [0, Math.SQRT1_2, -Math.SQRT1_2]
const right: Vec3 = [1, 0, 0]
const down: Vec3 = [0, -Math.SQRT1_2, -Math.SQRT1_2]
const rows = [right, down, forward].map((axis) => [...axis, -(axis[0] * centreM[0] + axis[1] * centreM[1] + axis[2] * centreM[2])])
const matrix = [0, 1, 2, 3].map((j) => f * rows[0][j] + cx * rows[2][j]).concat([0, 1, 2, 3].map((j) => f * rows[1][j] + cy * rows[2][j]), rows[2])
const camera: Camera = { matrix, centreM }

// A 10 m by 20 m box 30 m tall, counter-clockwise from its south-west corner.
const corners: [number, number][] = [[0, 0], [10, 0], [10, 20], [0, 20]]
const walls: Wall[] = corners.map((start, index) => {
  const end = corners[(index + 1) % 4]
  return { index, volumeId: 'box', start, end, lengthM: Math.hypot(end[0] - start[0], end[1] - start[1]), facingDeg: [180, 90, 0, 270][index], baseM: 0, topM: 30 }
})
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} is not ${expected}`)

test('a camera due south sees only the south face', () => {
  assert.deepEqual(walls.map((wall) => facesCamera(wall, camera)), [true, false, false, false])
})

test('hitWall finds the spot on the wall that projects to the click', () => {
  const pixel = project(camera, [4, 0, 12])
  assert.ok(pixel)
  const hit = hitWall(camera, walls, pixel)
  assert.equal(hit?.wall.index, 0)
  near(hit?.alongM ?? NaN, 4)
  near(hit?.heightM ?? NaN, 12)
})

test('hitWall answers null on the roof and off the building', () => {
  const roof = project(camera, [5, 10, 30])
  const sky = project(camera, [5, -5, 80])
  assert.ok(roof && sky)
  assert.equal(hitWall(camera, walls, roof), null)
  assert.equal(hitWall(camera, walls, sky), null)
})

test('signCorners lie on the wall and project inside the photo', () => {
  const sign = signCorners(walls[0], { alongM: 5, bottomM: 3, sizeM: { widthM: 4, heightM: 1 } })
  assert.deepEqual(sign, [[3, 0, 3], [7, 0, 3], [7, 0, 4], [3, 0, 4]])
  const [left, rightEdge] = sign.map((corner) => project(camera, corner))
  assert.ok(left && rightEdge && left[0] < rightEdge[0])
})

test('fitOnWall moves a sign inside its wall and shrinks one too large', () => {
  assert.deepEqual(fitOnWall(walls[0], { alongM: 9.5, bottomM: -1, sizeM: { widthM: 4, heightM: 1 } }), { alongM: 8, bottomM: 0, sizeM: { widthM: 4, heightM: 1 } })
  assert.deepEqual(fitOnWall(walls[0], { alongM: 5, bottomM: 3, sizeM: { widthM: 14, heightM: 1 } }).sizeM, { widthM: 10, heightM: 1 })
})

test('formatLength shows metres with feet and inches', () => {
  assert.equal(formatLength(3), '3.00 m · 9 ft 10 in')
})

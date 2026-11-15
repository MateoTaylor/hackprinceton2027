import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyNormal, facing, formatLength, groundProbes, signMeasures, type PlacedSign } from './signGeometry.ts'

// A 2.4 by 0.6 m sign centred 4 m up on a wall that faces +X.
const sign: PlacedSign = { id: 'o-1', position: [0, 4, 0], yawDeg: 0, sizeM: { widthM: 2.4, heightM: 0.6 } }
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`)

test('classifyNormal tells floors, walls and ceilings from slopes', () => {
  assert.equal(classifyNormal([0, 1, 0]), 'floor')
  assert.equal(classifyNormal([0, -1, 0]), 'ceiling')
  assert.equal(classifyNormal([0.95, 0.3, 0]), 'wall')
  assert.equal(classifyNormal([0.7, 0.7, 0]), null)
})

test('facing follows the yaw the server derives from a wall normal', () => {
  const [x, , z] = facing({ yawDeg: 270 })
  near(x, 0)
  near(z, 1)
})

test('groundProbes step out from the wall at the bottom edge', () => {
  assert.deepEqual(groundProbes(sign), [
    [0.3, 3.7, 0],
    [1, 3.7, 0],
    [2, 3.7, 0],
  ])
})

test('signMeasures gives width, height and the gap to the ground', () => {
  assert.deepEqual(
    signMeasures(sign).map(({ kind }) => kind),
    ['width', 'height'],
  )
  const [width, height, clearance] = signMeasures({ ...sign, groundY: 0.5 })
  near(width.lengthM, 2.4)
  near(height.lengthM, 0.6)
  near(clearance.lengthM, 3.2)
  near(clearance.from[1], 0.5)
  near(clearance.to[1], 3.7)
  near(Math.abs(width.to[2] - width.from[2]), 2.4)
})

test('formatLength shows metres and feet', () => {
  assert.equal(formatLength(2.4), '2.40 m · 7 ft 10 in')
  assert.equal(formatLength(0.3), '0.30 m · 1 ft 0 in')
  assert.equal(formatLength(3.05), '3.05 m · 10 ft 0 in')
})

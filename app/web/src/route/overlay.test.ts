import assert from 'node:assert/strict'
import { test } from 'node:test'
import { confidenceBand, type DoorMark, markUnder, resampleTrail } from './trail.ts'

test('a 10 m straight trail gives a point every half metre, ends included', () => {
  assert.equal(resampleTrail([[0, 0, 0], [10, 0, 0]], 0).length, 21)
})

test('points on other storeys drop out', () => {
  const trail: [number, number, number][] = [[0, 0, 0], [2, 0, 0], [2, 0, 1], [2, 4, 1]]
  const upstairs = resampleTrail(trail, 1)
  assert.equal(upstairs.length, 9)
  assert.deepEqual(upstairs[0], [2, 0])
  assert.equal(resampleTrail(trail, 0).length, 5)
  assert.equal(resampleTrail(trail, 2).length, 0)
})

test('confidence falls into bands at 0.3 and 0.6', () => {
  assert.deepEqual([0.29, 0.3, 0.59, 0.6].map(confidenceBand), ['bad', 'mid', 'mid', 'good'])
})

test('a hover over the floor below a raised mark finds its door, and the hit zone grows with the mark', () => {
  const view = { azimuthDeg: 45, elevationDeg: 35.264 }
  const door: DoorMark['door'] = { openingId: 'd', storeyIndex: 0, verdict: 'pass', clearanceM: 0.3, confidence: 0.8, limitedBy: 'width', source: 'costar', at: [0, 0] }
  const mark: DoorMark = { door, at: [0, 0], liftM: 0.7, sizeM: 0.6 }
  const back = 0.7 / Math.tan((35.264 * Math.PI) / 180)
  const under: [number, number] = [Math.SQRT1_2 * back, Math.SQRT1_2 * back]
  assert.equal(markUnder([mark], under, view), door)
  assert.equal(markUnder([mark], [under[0] + 0.5, under[1] - 0.5], view), null)
  assert.equal(markUnder([{ ...mark, sizeM: 2 }], [under[0] + 0.5, under[1] - 0.5], view), door)
})

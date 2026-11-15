import assert from 'node:assert/strict'
import { test } from 'node:test'
import { confidenceBand, type DoorMark, markUnder, resampleTrail, walkMs, walkReveal } from './trail.ts'

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

test('the walk shows dots from the entrance and a mark once it reaches the dot nearest the door', () => {
  const dots = resampleTrail([[0, 0, 0], [10, 0, 0]], 0)
  const doors: [number, number][] = [[0, 0.2], [5, -0.3], [10, 0]]
  assert.deepEqual(walkReveal(dots, doors, 0), { dots: 0, marks: [false, false, false] })
  assert.deepEqual(walkReveal(dots, doors, 0.5), { dots: 11, marks: [true, true, false] })
  assert.deepEqual(walkReveal(dots, doors, 0.45), { dots: 10, marks: [true, false, false] })
  assert.deepEqual(walkReveal(dots, doors, 1), { dots: 21, marks: [true, true, true] })
})

test('a finished walk shows every mark, even one on a storey with no dots', () => {
  assert.deepEqual(walkReveal([], [[3, 3]], 1), { dots: 0, marks: [true] })
})

test('a walk lasts 1.5 to 3 s whatever the route length', () => {
  assert.deepEqual([4, 200, 2000].map(walkMs), [1500, 2500, 3000])
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Ring } from '../../../server/src/model/building.ts'
import { wallSegments } from './storey.ts'

const square: Ring = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
]
const length = ({ a, b }: { a: [number, number]; b: [number, number] }) => Math.hypot(b[0] - a[0], b[1] - a[1])

test('a wall with one door splits into two segments with a gap of the door width', () => {
  const segments = wallSegments(square, [{ at: [4, 0], widthM: 0.9 }])
  const south = segments.filter(({ a, b }) => a[1] === 0 && b[1] === 0)
  assert.equal(south.length, 2)
  assert.deepEqual(south.map(({ a, b }) => [a[0], b[0]]), [
    [0, 3.55],
    [4.45, 10],
  ])
  assert.equal(segments.length, 5)
})

test('an opening off every edge leaves the walls whole', () => {
  const segments = wallSegments(square, [{ at: [5, 5], widthM: 0.9 }])
  assert.equal(segments.length, 4)
  assert.ok(segments.every((segment) => Math.abs(length(segment) - 10) < 1e-9))
})

test('the shared wall of two spaces gives the same segment from both rings', () => {
  const east: Ring = [
    [10, 0],
    [20, 0],
    [20, 10],
    [10, 10],
  ]
  const key = ({ a, b }: { a: [number, number]; b: [number, number] }) => [a.join(), b.join()].toSorted().join('|')
  const shared = [...wallSegments(square, []), ...wallSegments(east, [])].map(key)
  assert.equal(shared.length - new Set(shared).size, 1)
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cellBounds, coverCells } from './cells.ts'

test('a point near a cell corner covers the four cells around it', () => {
  assert.deepEqual(coverCells([{ lat: 34.0001, lon: -118.0001 }], 50), ['-5900_1699', '-5900_1700', '-5901_1699', '-5901_1700'])
})

test('two points deep in one cell give that cell once', () => {
  const cells = coverCells([{ lat: 34.01, lon: -118.01 }, { lat: 34.011, lon: -118.011 }], 100)
  assert.deepEqual(cells, ['-5901_1700'])
})

test('the order does not depend on the order of the points', () => {
  const points = [{ lat: 34.05, lon: -118.25 }, { lat: 29.76, lon: -95.37 }, { lat: 34.1, lon: -118.4 }]
  const cells = coverCells(points)
  assert.deepEqual(coverCells(points.toReversed()), cells)
  assert.deepEqual(cells, cells.toSorted())
})

test('a 1 km reach spans about 0.011 degrees of longitude and 0.009 of latitude each way', () => {
  assert.deepEqual(coverCells([{ lat: 34.01, lon: -118.01 }]), ['-5900_1700', '-5901_1700', '-5902_1700'])
  assert.deepEqual(cellBounds('-5901_1700'), { xmin: -5901 * 0.02, ymin: 1700 * 0.02, xmax: -5900 * 0.02, ymax: 1701 * 0.02 })
})

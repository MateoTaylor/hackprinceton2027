import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Point, Ring, Storey } from '../../model/building.ts'
import { FIXTURES } from '../../model/fixtures.ts'
import { ringBounds } from '../../model/geo.ts'
import { buildStoreyGrid, cellAt, neighbours, type StoreyGrid } from './grid.ts'

const STOREYS = Object.values(FIXTURES).flatMap(({ storeys }) => storeys)

function floodSpaces(grid: StoreyGrid, from: Point) {
  const start = cellAt(grid, from)
  const seen = new Set([start])
  const queue = [start]
  for (let cell = queue.pop(); cell !== undefined; cell = queue.pop()) {
    for (const { cell: next } of neighbours(grid, cell)) {
      if (!seen.has(next)) {
        seen.add(next)
        queue.push(next)
      }
    }
  }
  return new Set([...seen].map((cell) => grid.spaceIndex[cell]).filter((space) => space >= 0))
}

const area = ({ ring }: Storey) => {
  const { minX, minY, maxX, maxY } = ringBounds(ring)
  return (maxX - minX) * (maxY - minY)
}

test('every space of every fixture storey owns a cell', () => {
  for (const storey of STOREYS) {
    const owned = new Set(buildStoreyGrid(storey).spaceIndex)
    storey.spaces.forEach(({ id }, space) => assert.ok(owned.has(space), `${id} on storey ${storey.index} owns no cell`))
  }
})

test('builds the largest fixture storey quickly', (t) => {
  const largest = STOREYS.reduce((a, b) => (area(b) > area(a) ? b : a))
  const started = performance.now()
  const grid = buildStoreyGrid(largest)
  t.diagnostic(`${grid.cols * grid.rows} cells built in ${(performance.now() - started).toFixed(1)} ms`)
})

test('a room reaches the next room only through a door', () => {
  const storey = FIXTURES.apartment.storeys[0]
  const unit = storey.spaces.findIndex(({ id }) => id === 'a0-unit-sw')
  const centre: Point = [-8, -5.75]
  assert.equal(floodSpaces(buildStoreyGrid(storey), centre).size, storey.spaces.length)
  const shut = { ...storey, openings: storey.openings.filter(({ id }) => id !== 'a0-unit-sw-door') }
  assert.deepEqual(floodSpaces(buildStoreyGrid(shut), centre), new Set([unit]))
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkBuilding, type BuildingModel, type Opening, type Ring, type Space, type Storey } from '../../model/building.ts'
import { FIXTURES } from '../../model/fixtures.ts'
import { buildStoreyGrid, cellAt, isWalkable, neighbours } from '../route/grid.ts'
import { gapFill, indoorDoor, layoutOf, type Layout } from './gapFill.ts'

// A fixture with only its scanned spaces and the openings between them, as the gap fill gets it.
const scansOnly = ({ storeys }: BuildingModel): Storey[] =>
  storeys.map((storey) => {
    const spaces = storey.spaces.filter(({ source }) => source === 'scan')
    const kept = new Set(spaces.map(({ id }) => id))
    const openings = storey.openings.filter(({ spaceIds: [a, b] }) => kept.has(a) && (b === null || kept.has(b)))
    return { ...storey, spaces, openings, furnishings: [] }
  })

// The spaces of each storey a person reaches on foot from the street doors, taking any connector
// whose landing they reach.
function reachedSpaces(building: BuildingModel) {
  const grids = building.storeys.map((storey) => buildStoreyGrid(storey))
  const seen = grids.map(({ cols, rows }) => new Uint8Array(cols * rows))
  const queue: [number, number][] = []
  const visit = (storey: number, cell: number) => {
    if (cell < 0 || seen[storey][cell] || !isWalkable(grids[storey], cell)) return
    seen[storey][cell] = 1
    queue.push([storey, cell])
  }
  building.storeys[0].openings.forEach((opening, door) => {
    if (opening.kind !== 'exterior_door') return
    grids[0].doorIndex.forEach((index, cell) => index === door && visit(0, cell))
  })
  const landings = building.connectors.map(({ landings }) => landings.map(({ storeyIndex, at }) => [storeyIndex, cellAt(grids[storeyIndex], at)] as const))
  while (queue.length) {
    const [storey, cell] = queue.pop() ?? [0, 0]
    for (const next of neighbours(grids[storey], cell)) visit(storey, next.cell)
    for (const stops of landings) if (stops.some(([s, c]) => s === storey && c === cell)) stops.forEach(([s, c]) => visit(s, c))
  }
  return grids.map((grid, storey) => new Set([...seen[storey].keys()].filter((cell) => seen[storey][cell] && grid.spaceIndex[cell] >= 0).map((cell) => grid.spaceIndex[cell])))
}

const CASES: [keyof typeof FIXTURES, Layout][] = [['officeTower', 'office'], ['warehouse', 'warehouse'], ['apartment', 'apartment']]

for (const [name, layout] of CASES) {
  test(`the ${name} fills to a valid building whose every space is reached from the street`, () => {
    for (const seed of ['one', 'two', 'three']) {
      const fixture = FIXTURES[name]
      const filled = gapFill(scansOnly(fixture), [], `${name}-${seed}`, layout)
      const building = { ...fixture, storeys: filled.storeys, connectors: filled.connectors }
      assert.deepEqual(checkBuilding(building), [])
      const reached = reachedSpaces(building)
      building.storeys.forEach((storey, i) => assert.equal(reached[i].size, storey.spaces.length, `${seed}: storey ${i} reaches ${reached[i].size} of ${storey.spaces.length}`))
      assert.ok(building.storeys[0].openings.some(({ kind }) => kind === 'exterior_door'))
      if (building.storeys.length > 1) assert.deepEqual(filled.connectors.map(({ id }) => id), ['core-elevator', 'core-stair'])
    }
  })
}

test('the same property fills the same way', () => {
  const storeys = scansOnly(FIXTURES.officeTower)
  assert.deepEqual(gapFill(storeys, [], 'p', 'office'), gapFill(storeys, [], 'p', 'office'))
})

test('type labels pick a layout', () => {
  assert.deepEqual(['Office', 'Industrial', 'Multi-Family', 'Single Family', 'Retail'].map(layoutOf), ['office', 'warehouse', 'apartment', 'open', 'open'])
})

test("a suite's front door inside the building opens onto the floor around it, and one on the outside wall stays a street door", () => {
  const box = (x0: number, y0: number, x1: number, y1: number): Ring => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
  const provenance = { source: 'scan' as const, confidence: 0.8 }
  const spaces: Space[] = [{ id: 'suite', label: 'Suite', ring: box(10, 10, 20, 20), ...provenance }, { id: 'floor', label: 'Open floor', ring: box(0, 0, 10, 30), source: 'inferred', confidence: 0.3 }]
  const door = (at: [number, number], bearingDeg: number): Opening => ({ id: 'd', kind: 'exterior_door', at, widthM: 0.9, heightM: null, bearingDeg, spaceIds: ['suite', null], ...provenance })
  const ring = box(0, 0, 40, 30)
  assert.deepEqual(indoorDoor(door([10, 15], 270), ring, spaces).map(({ kind, spaceIds }) => [kind, spaceIds]), [['door', ['suite', 'floor']]])
  assert.deepEqual(indoorDoor(door([15, 20], 0), ring, spaces), [])
  assert.equal(indoorDoor(door([15, 30], 0), ring, spaces)[0]?.kind, 'exterior_door')
})

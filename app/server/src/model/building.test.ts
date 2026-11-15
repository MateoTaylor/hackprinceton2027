import assert from 'node:assert/strict'
import { test } from 'node:test'
import { type BuildingModel, checkBuilding } from './building.ts'
import { FIXTURES } from './fixtures.ts'

const broken = (fixture: BuildingModel, breakIt: (building: BuildingModel) => void) => {
  const building = structuredClone(fixture)
  breakIt(building)
  return checkBuilding(building)
}

for (const [name, fixture] of Object.entries(FIXTURES)) {
  test(`the ${name} fixture has no problem`, () => {
    assert.deepEqual(checkBuilding(fixture), [])
  })
}

test('the fixtures are the buildings the lanes build on', () => {
  const { officeTower, warehouse, apartment } = FIXTURES
  assert.equal(officeTower.storeys.length, 12)
  assert.equal(officeTower.shell.volumes.length, 2)
  assert.ok(officeTower.connectors.every(({ landings }) => landings.length === 12))
  assert.equal(warehouse.storeys.length, 1)
  assert.ok(warehouse.storeys[0].furnishings.some(({ kind }) => kind === 'rack'))
  assert.equal(apartment.storeys.length, 3)
  assert.ok(apartment.storeys.every(({ spaces }) => spaces.filter(({ label }) => label.startsWith('Unit')).length === 4))
  for (const fixture of [officeTower, apartment]) {
    assert.equal(fixture.scans.length, 1)
    assert.equal(fixture.scans[0].storeyIndexes.length, 1)
  }
})

test('a value that is not a building returns its schema issues', () => {
  assert.deepEqual(checkBuilding(null), ['building: Invalid input: expected object, received null'])
})

test('a repeated id is a problem', () => {
  const problems = broken(FIXTURES.officeTower, ({ storeys }) => {
    storeys[2].furnishings[0].id = storeys[1].furnishings[0].id
  })
  assert.deepEqual(problems, ['The id "s1-desk-1" is used 2 times.'])
})

test('a space id that names nothing is a problem', () => {
  const problems = broken(FIXTURES.warehouse, ({ storeys }) => {
    storeys[0].furnishings[0].spaceId = 'wh-nowhere'
  })
  assert.deepEqual(problems, ['Furnishing "wh-desk-1" names space "wh-nowhere", which storey 0 does not have.'])
})

test('an opening id that names nothing is a problem', () => {
  const problems = broken(FIXTURES.apartment, ({ connectors }) => {
    connectors[0].landings[1].openingId = 'a1-nowhere'
  })
  assert.deepEqual(problems, ['Connector "apartment-stair" names opening "a1-nowhere", which storey 1 does not have.'])
})

test('a storey index that names nothing is a problem', () => {
  const problems = broken(FIXTURES.apartment, ({ scans }) => {
    scans[0].storeyIndexes = [7]
  })
  assert.deepEqual(problems, ['Scan "fixture-apartment-scan" covers storey 7, which does not exist.'])
})

test('a ring under three points is a problem', () => {
  const problems = broken(FIXTURES.warehouse, ({ storeys }) => {
    storeys[0].spaces[0].ring.length = 2
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /^storeys\.0\.spaces\.0\.ring: Too small/)
})

test('a clockwise ring is a problem', () => {
  const problems = broken(FIXTURES.officeTower, ({ storeys }) => {
    storeys[3].spaces[1].ring.reverse()
  })
  assert.deepEqual(problems, ['Space "s3-core" has a ring with no positive area. Rings run counter-clockwise.'])
})

test('a space outside its storey is a problem', () => {
  const problems = broken(FIXTURES.officeTower, ({ storeys }) => {
    storeys[4].spaces[2].ring = storeys[4].spaces[2].ring.map(([x, y]) => [x + 0.06, y])
  })
  assert.deepEqual(problems, ['Space "s4-east" reaches outside storey 4 at 2 of its 4 corners.'])
})

test('a space within 5 cm of its storey is not a problem', () => {
  const problems = broken(FIXTURES.officeTower, ({ storeys }) => {
    storeys[4].spaces[2].ring = storeys[4].spaces[2].ring.map(([x, y]) => [x + 0.04, y])
  })
  assert.deepEqual(problems, [])
})

test('a gap between storeys is a problem', () => {
  const problems = broken(FIXTURES.apartment, ({ storeys }) => {
    storeys[2].elevationM += 0.5
  })
  assert.deepEqual(problems, ['Storey 2 starts 0.50 m from the top of storey 1.'])
})

test('storeys out of order are a problem', () => {
  const problems = broken(FIXTURES.apartment, ({ storeys }) => {
    storeys[0].index = 1
    storeys[1].index = 0
  })
  assert.deepEqual(problems, [
    'Storey 1 sits at position 0. Storeys run from index 0 upward in order.',
    'Storey 0 sits at position 1. Storeys run from index 0 upward in order.',
  ])
})

test('an inferred value without a confidence is a problem', () => {
  const problems = broken(FIXTURES.warehouse, ({ storeys }) => {
    assert.equal(storeys[0].spaces[1].source, 'inferred')
    Reflect.deleteProperty(storeys[0].spaces[1], 'confidence')
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /^storeys\.0\.spaces\.1\.confidence: /)
})

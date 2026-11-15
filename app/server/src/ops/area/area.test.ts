import { DuckDBInstance } from '@duckdb/node-api'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import type { Property } from '../../../../shared/property.ts'
import { createDiskCache } from '../../cache.ts'
import { createVexcel } from '../../vexcel.ts'
import { type OpContext, RESULT_MAX_CHARS, runOp } from '../op.ts'
import { coverCells } from './cells.ts'
import { areaPlaces, areaSummary } from './index.ts'

const PIN = { lat: 34.05, lon: -118.25 }
const property = (id: string, lat: number, lon: number): Property => ({
  id,
  kind: 'commercial',
  costarId: '1',
  name: 'Invented Plaza',
  address: '1 Invented Way',
  lat,
  lon,
  typeLabel: 'Office',
  facts: [],
  photoUrl: null,
  scans: [],
})
const PROPERTIES = new Map([
  ['p1', property('p1', PIN.lat, PIN.lon)],
  ['far', property('far', 33.5, -117.5)],
])

const roots: string[] = []
let built = ''
let spatial = true
after(() => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))))

const at = (dLat: number, dLon: number) => `ST_Point(${PIN.lon + dLon}, ${PIN.lat + dLat})`
const line = (from: [number, number], to: [number, number]) =>
  `ST_MakeLine(${at(...from)}, ${at(...to)})`

// An invented area.duckdb around PIN with only the cells PIN needs, in a fresh temp folder.
before(async () => {
  built = await mkdtemp(join(tmpdir(), 'propstar-area-'))
  roots.push(built)
  const instance = await DuckDBInstance.create(join(built, 'area.duckdb'), { autoinstall_known_extensions: 'false' })
  const db = await instance.connect()
  try {
    await db.run('LOAD spatial')
  } catch {
    spatial = false
    return
  }
  const utm = (geom: string) => `ST_Transform(${geom}, 'EPSG:4326', 'EPSG:32611', always_xy := true)`
  const place = (id: string, name: string | null, category: string, geom: string) =>
    `('${id}', ${name === null ? 'NULL' : `'${name}'`}, '${category}', ${geom}, ${utm(geom)})`
  const segment = (id: string, name: string, roadClass: string, geom: string) => `('${id}', '${name}', '${roadClass}', ${geom}, ${utm(geom)})`
  await db.run(`
    CREATE TABLE segments (id VARCHAR, name VARCHAR, class VARCHAR, geom GEOMETRY, geom_utm GEOMETRY);
    CREATE TABLE places (id VARCHAR, name VARCHAR, basic_category VARCHAR, geom GEOMETRY, geom_utm GEOMETRY);
    CREATE TABLE cells (cell_id VARCHAR, theme VARCHAR, rows INTEGER, seconds DOUBLE);
    INSERT INTO places VALUES
      ${place('a', 'Bistro', 'restaurant', at(0.001, 0))},
      ${place('b', 'Cafe Uno', 'coffee_shop', at(0.002, 0))},
      ${place('c', 'Invented Bank', 'bank_or_credit_union', at(0, 0.003))},
      ${place('d', 'Far Diner', 'restaurant', at(0.02, 0))},
      ${place('e', 'Shoe Shop', 'fashion_and_apparel_store', at(0.0005, 0))},
      ${place('f', null, 'restaurant', at(0.0003, 0))};
    INSERT INTO segments VALUES
      ${segment('s1', 'Back Alley', 'service', line([0.00005, -0.001], [0.00005, 0.001]))},
      ${segment('s3', 'Invented Freeway', 'motorway', line([0.0001, -0.001], [0.0001, 0.001]))},
      ${segment('s2', 'Main Street', 'residential', line([-0.0003, -0.001], [-0.0003, 0.001]))};
  `)
  for (const cell of coverCells([PIN])) await db.run(`INSERT INTO cells VALUES ('${cell}', 'segment', 1, 0), ('${cell}', 'place', 1, 0)`)
  db.closeSync()
  instance.closeSync()
})

const contextAt = (dataDir: string): OpContext => ({
  properties: PROPERTIES,
  vexcel: createVexcel({
    apiKey: 'k',
    cache: createDiskCache(dataDir),
    fetch: async () => {
      throw new Error('area ops never call Vexcel')
    },
  }),
  matterport: null,
  buildingFacts: new Map(),
  dataDir,
  edit: async () => {
    throw new Error('area ops never call the edit API')
  },
  call: async () => {
    throw new Error('area ops call no other op')
  },
})

test('area_places lists named grouped places in the radius, nearest first', async (t) => {
  if (!spatial) return t.skip('spatial is not installed')
  const answer = await runOp(areaPlaces, contextAt(built), { propertyId: 'p1', radiusM: 500 }, { detail: true })
  assert.ok(answer.ok)
  assert.deepEqual(
    answer.result.places.map(({ name, group }) => [name, group]),
    [
      ['Bistro', 'food'],
      ['Cafe Uno', 'food'],
      ['Invented Bank', 'bank'],
    ],
  )
  const bearings = answer.result.places.map(({ bearingDeg }) => bearingDeg)
  ;[0, 0, 90].forEach((compass, n) => assert.ok(Math.abs(bearings[n] - compass) <= 1, 'grid bearing is within a degree of compass'))
  assert.equal(answer.result.total, 3)
  assert.equal(answer.result.source, 'overture')
  assert.ok(Math.abs(answer.result.places[0].distanceM - 111) <= 2)
  assert.equal(typeof answer.detail?.places[0].lat, 'number')
})

test('area_places filters by group and counts the total before the limit', async (t) => {
  if (!spatial) return t.skip('spatial is not installed')
  const food = await runOp(areaPlaces, contextAt(built), { propertyId: 'p1', group: 'food', radiusM: 500, limit: 1 })
  assert.ok(food.ok)
  assert.deepEqual(food.result.places.map(({ name }) => name), ['Bistro'])
  assert.equal(food.result.total, 2)
})

test('area_summary counts every group, names the nearest and skips a service road and a motorway for the front', async (t) => {
  if (!spatial) return t.skip('spatial is not installed')
  const answer = await runOp(areaSummary, contextAt(built), { propertyId: 'p1', radiusM: 500 })
  assert.ok(answer.ok)
  assert.deepEqual(answer.result.counts, { food: 2, grocery: 0, transit: 0, health: 0, school: 0, park: 0, bank: 1, fuel: 0 })
  assert.deepEqual(answer.result.nearest.map(({ group, name }) => [group, name]), [
    ['food', 'Bistro'],
    ['bank', 'Invented Bank'],
  ])
  assert.equal(answer.result.frontingStreet?.name, 'Main Street')
  assert.ok(Math.abs((answer.result.frontingStreet?.bearingDeg ?? 0) - 180) <= 1, 'Main Street lies south')
  assert.ok(JSON.stringify(answer.result).length <= RESULT_MAX_CHARS)
})

test('a property outside the loaded cells is not_ready', async (t) => {
  if (!spatial) return t.skip('spatial is not installed')
  const answer = await runOp(areaSummary, contextAt(built), { propertyId: 'far' })
  assert.ok(!answer.ok)
  assert.equal(answer.error.code, 'not_ready')
  assert.match(answer.error.message, /does not cover/)
})

test('a missing area.duckdb is not_ready with the build command', async () => {
  const empty = await mkdtemp(join(tmpdir(), 'propstar-area-empty-'))
  roots.push(empty)
  const answer = await runOp(areaPlaces, contextAt(empty), { propertyId: 'p1' })
  assert.ok(!answer.ok)
  assert.equal(answer.error.code, 'not_ready')
  assert.match(answer.error.hint, /build:area/)
})

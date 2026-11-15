// Builds data/propstar/search.duckdb, the tables `property_query` reads. Run it with
// `node pipeline/search.ts` after `pnpm build:data`, and again after `pnpm build:area` loads more
// cells. It needs no key and calls out to nothing. It prints counts only, never a name.
//
// Tables:
//   search      one row per property, named columns only (no `facts`, no `photo_url`)
//     id, kind, name, address, lat, lon, type_label, year_built, building_sf, units, stories,
//     beds, baths, price_usd, rent_usd_month, scan_count, area_covered
//   near_roads  property_id, class, name, distance_m     one row per property, road class and name
//               within 1000 m, for covered properties only
// A property is covered when every area cell within 1000 m of it is loaded for both themes, the
// same rule area.ts uses for its `covered` table. Without area.duckdb no property is covered.
import { DuckDBInstance } from '@duckdb/node-api'
import { existsSync } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { coverCells } from '../src/ops/area/cells.ts'

const OUT = new URL('../../../data/propstar/', import.meta.url)
const SEARCH_PATH = fileURLToPath(new URL('search.duckdb', OUT))
const PROPSTAR_PATH = fileURLToPath(new URL('propstar.duckdb', OUT))
const AREA_PATH = fileURLToPath(new URL('area.duckdb', OUT))
const REACH_M = 1000
const THEMES = ['segment', 'place']

const quote = (path: string) => `'${path.replaceAll("'", "''")}'`
const count = async (sql: string) => Number((await connection.runAndReadAll(sql)).getRowsJS()[0][0])

const TEMP_PATH = `${SEARCH_PATH}.tmp`
await rm(TEMP_PATH, { force: true })
await rm(`${TEMP_PATH}.wal`, { force: true })
const db = await DuckDBInstance.create(TEMP_PATH)
const connection = await db.connect()
await connection.run(`ATTACH ${quote(PROPSTAR_PATH)} AS propstar (READ_ONLY)`)
await connection.run(`
  CREATE TABLE search AS
  SELECT id, kind, name, address, lat, lon, type_label, year_built, building_sf, units, stories,
    beds, baths, price_usd, rent_usd_month, len(scans) AS scan_count, false AS area_covered
  FROM propstar.properties ORDER BY id`)
await connection.run('CREATE TABLE near_roads (property_id VARCHAR, class VARCHAR, name VARCHAR, distance_m DOUBLE)')

// A running `pnpm build:area` holds a write lock, so build without the area table and say so.
const attachArea = async () => {
  if (!existsSync(AREA_PATH)) return 'no area.duckdb'
  try {
    await connection.run(`INSTALL spatial; LOAD spatial; ATTACH ${quote(AREA_PATH)} AS area (READ_ONLY)`)
    return null
  } catch (error) {
    if (error instanceof Error && error.message.includes('Could not set lock')) return 'area.duckdb is locked by a running build:area'
    throw error
  }
}
const areaMissing = await attachArea()
const hasArea = areaMissing === null
if (hasArea) {
  const classes = (await connection.runAndReadAll('SELECT class, count(*) FROM area.segments GROUP BY 1 ORDER BY 2 DESC')).getRowsJS()
  console.log(`segments by class: ${classes.map(([c, n]) => `${c} ${n}`).join(', ')}`)
  if (!classes.some(([c]) => c === 'motorway')) throw new Error('area.segments has no motorway rows. Ask the main session before building.')

  const loaded = new Set((await connection.runAndReadAll('SELECT cell_id, theme FROM area.cells')).getRowsJS().map(([cell, theme]) => `${cell} ${theme}`))
  const points = (await connection.runAndReadAll('SELECT id, lat, lon FROM search')).getRowObjectsJS() as { id: string; lat: number; lon: number }[]
  const covered = points
    .filter((p) => coverCells([p], REACH_M).every((cell) => THEMES.every((theme) => loaded.has(`${cell} ${theme}`))))
    .map((p) => p.id)
  if (covered.length > 0) await connection.run(`UPDATE search SET area_covered = true WHERE id IN (${covered.map(quote).join(', ')})`)

  await connection.run(`
    INSERT INTO near_roads
    WITH point AS (
      SELECT id, ST_Transform(ST_Point(lon, lat), 'EPSG:4326', 'EPSG:32611', always_xy := true) AS utm
      FROM search WHERE area_covered
    )
    SELECT p.id, s.class, s.name, round(min(ST_Distance(p.utm, s.geom_utm)), 1)
    FROM point p JOIN area.segments s ON ST_DWithin(p.utm, s.geom_utm, ${REACH_M})
    GROUP BY p.id, s.class, s.name
    ORDER BY p.id, 4`)
}

console.log(`search ${await count('SELECT count(*) FROM search')} rows, ${await count('SELECT count(*) FROM search WHERE area_covered')} covered`)
console.log(`near_roads ${await count('SELECT count(*) FROM near_roads')} rows${areaMissing ? ` (${areaMissing}, rerun when it finishes)` : ''}`)
await connection.run('CHECKPOINT')
connection.closeSync()
db.closeSync()
await rename(TEMP_PATH, SEARCH_PATH)
console.log('wrote data/propstar/search.duckdb')

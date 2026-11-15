// Builds data/propstar/area.duckdb, the Overture streets and places around every property, so the
// area ops never call out at request time. Run it with `pnpm build:area` after `pnpm build:data`.
// It needs no key. A stopped run resumes: every (cell, theme) already in `cells` is skipped.
//
// Tables:
//   segments  id, name, class, geom, geom_utm               Overture road segments
//   places    id, name, basic_category, taxonomy, geom, geom_utm
//   cells     cell_id, theme ('segment' | 'place'), rows, seconds   one row per loaded cell
//   covered   property_id                                    properties whose every cell is loaded
// `geom` is WGS84 lon/lat. `geom_utm` is EPSG:32611 metres, which every property falls in.
import { DuckDBInstance } from '@duckdb/node-api'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { cellBounds, coverCells } from '../src/ops/area/cells.ts'

const RELEASE = '2026-10-21.0'
const OUT = new URL('../../../data/propstar/', import.meta.url)
const AREA_PATH = fileURLToPath(new URL('area.duckdb', OUT))
const PROPSTAR_PATH = fileURLToPath(new URL('propstar.duckdb', OUT))
const UTM = `ST_Transform(geometry, 'EPSG:4326', 'EPSG:32611', always_xy := true)`

const THEMES = [
  {
    theme: 'segment',
    table: 'segments',
    path: 'theme=transportation/type=segment',
    columns: `id, names.primary, class, geometry, ${UTM}`,
    where: `subtype = 'road'`,
  },
  {
    theme: 'place',
    table: 'places',
    path: 'theme=places/type=place',
    columns: `id, names.primary, basic_category, taxonomy, geometry, ${UTM}`,
    where: 'true',
  },
] as const

const quote = (path: string) => `'${path.replaceAll("'", "''")}'`
const seconds = (since: number) => Math.round((performance.now() - since) / 100) / 10

const started = performance.now()
await mkdir(OUT, { recursive: true })
const db = await DuckDBInstance.create(AREA_PATH)
const connection = await db.connect()
await connection.run(`
  INSTALL spatial; LOAD spatial; INSTALL httpfs; LOAD httpfs;
  SET s3_region = 'us-west-2';
  SET enable_http_metadata_cache = true;
  SET parquet_metadata_cache = true;
  CREATE TABLE IF NOT EXISTS segments (id VARCHAR PRIMARY KEY, name VARCHAR, class VARCHAR, geom GEOMETRY, geom_utm GEOMETRY);
  CREATE TABLE IF NOT EXISTS places (
    id VARCHAR PRIMARY KEY, name VARCHAR, basic_category VARCHAR,
    taxonomy STRUCT("primary" VARCHAR, hierarchy VARCHAR[], alternates VARCHAR[]),
    geom GEOMETRY, geom_utm GEOMETRY
  );
  CREATE TABLE IF NOT EXISTS cells (cell_id VARCHAR, theme VARCHAR, rows INTEGER, seconds DOUBLE, PRIMARY KEY (cell_id, theme));
  CREATE TABLE IF NOT EXISTS covered (property_id VARCHAR PRIMARY KEY);
  ATTACH ${quote(PROPSTAR_PATH)} AS propstar (READ_ONLY);
`)

const properties = (await connection.runAndReadAll('SELECT id, lat, lon FROM propstar.properties ORDER BY id')).getRowObjectsJS() as {
  id: string
  lat: number
  lon: number
}[]
const cells = coverCells(properties)
const loaded = new Set(
  (await connection.runAndReadAll('SELECT cell_id, theme FROM cells')).getRowsJS().map(([cell, theme]) => `${cell} ${theme}`),
)
console.log(`${properties.length} properties, ${cells.length} cells`)

for (const cell of cells) {
  const { xmin, ymin, xmax, ymax } = cellBounds(cell)
  for (const { theme, table, path, columns, where } of THEMES) {
    if (loaded.has(`${cell} ${theme}`)) {
      console.log(`${cell} ${theme} skip`)
      continue
    }
    const since = performance.now()
    await connection.run('BEGIN TRANSACTION')
    await connection.run(`
      CREATE OR REPLACE TEMP TABLE batch AS
      SELECT ${columns}
      FROM read_parquet('s3://overturemaps-us-west-2/release/${RELEASE}/${path}/*')
      WHERE ${where} AND bbox.xmin <= ${xmax} AND bbox.xmax >= ${xmin} AND bbox.ymin <= ${ymax} AND bbox.ymax >= ${ymin}
    `)
    await connection.run(`INSERT INTO ${table} SELECT * FROM batch ON CONFLICT DO NOTHING`)
    const took = seconds(since)
    const reader = await connection.runAndReadAll(
      `INSERT INTO cells SELECT $1, $2, count(*), $3 FROM batch RETURNING rows`,
      [cell, theme, took],
    )
    await connection.run('COMMIT')
    console.log(`${cell} ${theme} ${reader.getRowsJS()[0][0]} rows ${took} s`)
  }
}

await connection.run('INSERT INTO covered SELECT id FROM propstar.properties ON CONFLICT DO NOTHING')
for (const table of ['segments', 'places', 'cells', 'covered']) {
  const [[count]] = (await connection.runAndReadAll(`SELECT count(*) FROM ${table}`)).getRowsJS()
  console.log(`${table} ${count} rows`)
}
connection.closeSync()
db.closeSync()
console.log(`done in ${seconds(started)} s`)

import { join } from 'node:path'
import { z } from 'zod'
import { Assumptions, defineOp } from '../op.ts'
import { MAX_ROWS, openSearch, type Search } from './query.ts'

const SQL_HELP = `One read-only DuckDB SELECT or WITH statement, at most 2000 characters. At most ${MAX_ROWS} rows come back.
Tables:
- search: one row per property. id VARCHAR (pass to property_get), kind VARCHAR ('commercial' | 'residential'), name VARCHAR, address VARCHAR, lat DOUBLE, lon DOUBLE (WGS84 degrees), type_label VARCHAR ('Multi-Family', 'Office', 'Single Family', 'Retail', 'Condo', 'Industrial', 'Flex', 'Townhouse', 'Specialty', 'Healthcare', 'Hotel'), year_built INTEGER, building_sf DOUBLE (square feet; living area for homes), units INTEGER, stories INTEGER (above grade), beds INTEGER, baths DOUBLE, price_usd DOUBLE (sale or asking price, homes only), rent_usd_month DOUBLE (USD per month, homes only), scan_count INTEGER (readable Matterport scans), area_covered BOOLEAN (true when near_roads holds this property's roads). Numbers are null when CoStar has none.
- near_roads: property_id VARCHAR (= search.id), class VARCHAR (Overture road class: 'motorway', 'primary', 'secondary', 'tertiary', 'residential', 'service', 'unclassified', 'footway', 'path', 'steps', 'cycleway', 'pedestrian', 'track', 'unknown'), name VARCHAR (null when unnamed), distance_m DOUBLE (straight-line metres to the nearest segment of that road, at most 1000). One row per property, class and name.
Match text with ILIKE, such as name ILIKE '%tower%'.
Example: SELECT s.id, s.type_label FROM search s WHERE s.area_covered AND NOT EXISTS (SELECT 1 FROM near_roads r WHERE r.property_id = s.id AND r.class = 'motorway' AND r.distance_m < 300) LIMIT 20`

const ASSUMPTIONS = [
  '`near_roads` comes from Overture release 2026-10-21.0 and holds straight-line distances up to 1000 m.',
  'A property whose `area_covered` is false has no row in `near_roads`.',
]

// One open database per path, opened on first call. A failed open is forgotten, so the next call
// tries again after `node pipeline/search.ts` builds the file.
const opened = new Map<string, Promise<Search>>()
function searchAt(dataDir: string) {
  const path = join(dataDir, 'search.duckdb')
  let search = opened.get(path)
  if (!search) {
    search = openSearch(path)
    opened.set(path, search)
    search.catch(() => opened.delete(path))
  }
  return search
}

const propertyQuery = defineOp({
  name: 'property_query',
  summary: 'Search and filter every property with one read-only SQL SELECT over the search and near_roads tables.',
  effect: 'read',
  input: z.object({ sql: z.string().min(1).max(2000).describe(SQL_HELP) }),
  output: z.object({
    columns: z.array(z.string()),
    rows: z.array(z.array(z.unknown())),
    rowCount: z.int(),
    truncated: z.boolean(),
    assumptions: Assumptions,
  }),
})(async (ctx, { sql }) => {
  const search = await searchAt(ctx.dataDir)
  const reserved = JSON.stringify({ assumptions: ASSUMPTIONS }).length
  return { result: { ...(await search.query(sql, reserved)), assumptions: ASSUMPTIONS } }
})

export const SEARCH_OPS = [propertyQuery]

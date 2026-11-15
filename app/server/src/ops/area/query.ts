import type { DuckDBConnection } from '@duckdb/node-api'
import { z } from 'zod'
import { OpError } from '../op.ts'
import { type AreaGroup, CATEGORY_GROUPS } from './categories.ts'
import { coverCells } from './cells.ts'

// The furthest a fronting street may be from the pin, and the road classes that never front a
// building: a motorway has no driveways, and the rest carry no car or address.
const FRONTING_MAX_M = 150
const NOT_FRONTING = ['motorway', 'footway', 'service', 'steps', 'path', 'cycleway', 'pedestrian', 'track', 'bridleway']

const PIN = `ST_Transform(ST_Point($1, $2), 'EPSG:4326', 'EPSG:32611', always_xy := true)`

// The street a property faces, as seen from its pin. `bearingDeg` points from the pin to the
// nearest point of the street, clockwise from grid north.
export const FrontingStreet = z
  .object({ name: z.string(), roadClass: z.string(), bearingDeg: z.int().min(0).max(359), distanceM: z.int().min(0) })
  .nullable()

export type AreaPlace = { name: string; group: AreaGroup; category: string; distanceM: number; bearingDeg: number; lat: number; lon: number }

type Point = { lat: number; lon: number }

const PlaceRow = z.object({ name: z.string(), category: z.string(), d: z.number(), dx: z.number(), dy: z.number(), lat: z.number(), lon: z.number() })
const StreetRow = z.object({ name: z.string(), roadClass: z.string(), d: z.number(), dx: z.number(), dy: z.number() })

const bearing = (dx: number, dy: number) => Math.round((((Math.atan2(dx, dy) * 180) / Math.PI) % 360) + 360) % 360

// Throws `not_ready` unless every cell around the point is loaded for both themes.
async function requireCovered(db: DuckDBConnection, point: Point) {
  const loaded = new Set((await db.runAndReadAll('SELECT cell_id, theme FROM cells')).getRowsJS().map(([cell, theme]) => `${cell} ${theme}`))
  const covered = coverCells([point]).every((cell) => loaded.has(`${cell} segment`) && loaded.has(`${cell} place`))
  if (!covered) {
    throw new OpError('not_ready', 'The area data does not cover this property yet.', 'Run `pnpm --dir app/server build:area` again to cover this property.')
  }
}

// Named places in a group within `radiusM` of the point, nearest first, ties by name.
export async function placesNear(db: DuckDBConnection, point: Point, radiusM: number): Promise<AreaPlace[]> {
  await requireCovered(db, point)
  const rows = (
    await db.runAndReadAll(
      `WITH pin AS (SELECT ${PIN} AS pt)
       SELECT name, basic_category AS category, ST_Distance(geom_utm, pt) AS d,
              ST_X(geom_utm) - ST_X(pt) AS dx, ST_Y(geom_utm) - ST_Y(pt) AS dy, ST_Y(geom) AS lat, ST_X(geom) AS lon
       FROM places, pin
       WHERE name IS NOT NULL AND basic_category IS NOT NULL AND ST_DWithin(geom_utm, pt, $3)`,
      [point.lon, point.lat, radiusM],
    )
  ).getRowObjectsJS()
  return z
    .array(PlaceRow)
    .parse(rows)
    .flatMap(({ name, category, d, dx, dy, lat, lon }) => {
      const group = CATEGORY_GROUPS.get(category)
      return group ? [{ name, group, category, distanceM: Math.round(d), bearingDeg: bearing(dx, dy), lat, lon }] : []
    })
    .toSorted((a, b) => a.distanceM - b.distanceM || a.name.localeCompare(b.name))
}

// The nearest named street within FRONTING_MAX_M of the point that a building can front, or null.
export async function frontingStreet(db: DuckDBConnection, point: Point): Promise<z.infer<typeof FrontingStreet>> {
  await requireCovered(db, point)
  const rows = (
    await db.runAndReadAll(
      `WITH pin AS (SELECT ${PIN} AS pt)
       SELECT name, class AS "roadClass", ST_Distance(geom_utm, pt) AS d,
              ST_X(ST_EndPoint(ST_ShortestLine(pt, geom_utm))) - ST_X(pt) AS dx,
              ST_Y(ST_EndPoint(ST_ShortestLine(pt, geom_utm))) - ST_Y(pt) AS dy
       FROM segments, pin
       WHERE name IS NOT NULL AND class IS NOT NULL AND class NOT IN (${NOT_FRONTING.map((c) => `'${c}'`).join(', ')})
         AND ST_DWithin(geom_utm, pt, $3)
       ORDER BY d, name
       LIMIT 1`,
      [point.lon, point.lat, FRONTING_MAX_M],
    )
  ).getRowObjectsJS()
  const [row] = z.array(StreetRow).parse(rows)
  return row ? { name: row.name, roadClass: row.roadClass, bearingDeg: bearing(row.dx, row.dy), distanceM: Math.round(row.d) } : null
}

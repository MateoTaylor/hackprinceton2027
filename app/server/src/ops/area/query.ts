import type { DuckDBConnection } from '@duckdb/node-api'
import { z } from 'zod'
import { OpError } from '../op.ts'
import { type AreaGroup, CATEGORY_GROUPS } from './categories.ts'
import { coverCells } from './cells.ts'

// The road classes in Overture's `class` column for road segments.
export const ROAD_CLASSES = [
  'motorway',
  'trunk',
  'primary',
  'secondary',
  'tertiary',
  'residential',
  'living_street',
  'unclassified',
  'service',
  'pedestrian',
  'footway',
  'steps',
  'path',
  'track',
  'cycleway',
  'bridleway',
  'unknown',
] as const

// The furthest a fronting street may be from the pin, and the road classes that never front a
// building: a motorway has no driveways, and the rest carry no car or address.
const FRONTING_MAX_M = 150
const NOT_FRONTING = new Set(['motorway', 'footway', 'service', 'steps', 'path', 'cycleway', 'pedestrian', 'track', 'bridleway'])

const PIN = `ST_Transform(ST_Point($1, $2), 'EPSG:4326', 'EPSG:32611', always_xy := true)`

type Point = { lat: number; lon: number }

export type AreaPlace = { name: string; group: AreaGroup; category: string; distanceM: number; bearingDeg: number; lat: number; lon: number }

// One named road as seen from a property's pin: all its segments of one class taken together.
// `distanceM` and `bearingDeg` point at its nearest point, clockwise from grid north.
export type AreaRoad = { name: string; roadClass: string; distanceM: number; bearingDeg: number }

const PlaceRow = z.object({ name: z.string(), category: z.string(), d: z.number(), dx: z.number(), dy: z.number(), lat: z.number(), lon: z.number() })
const RoadRow = z.object({ name: z.string(), roadClass: z.string(), d: z.number(), dx: z.number(), dy: z.number() })

const bearing = (dx: number, dy: number) => Math.round((((Math.atan2(dx, dy) * 180) / Math.PI) % 360) + 360) % 360
const nearestFirst = (a: { distanceM: number; name: string }, b: { distanceM: number; name: string }) =>
  a.distanceM - b.distanceM || a.name.localeCompare(b.name)

// Throws `not_ready` unless every cell within `reachM` of the point is loaded for both themes.
async function requireCovered(db: DuckDBConnection, point: Point, reachM: number) {
  const loaded = new Set((await db.runAndReadAll('SELECT cell_id, theme FROM cells')).getRowsJS().map(([cell, theme]) => `${cell} ${theme}`))
  const covered = coverCells([point], reachM).every((cell) => loaded.has(`${cell} segment`) && loaded.has(`${cell} place`))
  if (!covered) {
    throw new OpError('not_ready', 'The area data does not cover this property yet.', 'Run `pnpm --dir app/server build:area` again to cover this property.')
  }
}

// Named places in a group within `radiusM` of the point, nearest first, ties by name.
export async function placesNear(db: DuckDBConnection, point: Point, radiusM: number): Promise<AreaPlace[]> {
  await requireCovered(db, point, radiusM)
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
    .toSorted(nearestFirst)
}

// Named roads within `radiusM` of the point, one per name and class, nearest first, ties by name.
export async function roadsNear(db: DuckDBConnection, point: Point, radiusM: number): Promise<AreaRoad[]> {
  await requireCovered(db, point, radiusM)
  const rows = (
    await db.runAndReadAll(
      `WITH pin AS (SELECT ${PIN} AS pt),
       near AS (
         SELECT name, class, ST_Distance(geom_utm, pt) AS d, ST_EndPoint(ST_ShortestLine(pt, geom_utm)) AS e, pt
         FROM segments, pin
         WHERE name IS NOT NULL AND class IS NOT NULL AND ST_DWithin(geom_utm, pt, $3)
       )
       SELECT name, class AS "roadClass", min(d) AS d, arg_min(ST_X(e) - ST_X(pt), d) AS dx, arg_min(ST_Y(e) - ST_Y(pt), d) AS dy
       FROM near GROUP BY name, class`,
      [point.lon, point.lat, radiusM],
    )
  ).getRowObjectsJS()
  return z
    .array(RoadRow)
    .parse(rows)
    .map(({ name, roadClass, d, dx, dy }) => ({ name, roadClass, distanceM: Math.round(d), bearingDeg: bearing(dx, dy) }))
    .toSorted(nearestFirst)
}

// The street a building at the point faces: the nearest named road within FRONTING_MAX_M whose
// class a building can front, or null.
export async function frontingStreet(db: DuckDBConnection, point: Point) {
  return (await roadsNear(db, point, FRONTING_MAX_M)).find(({ roadClass }) => !NOT_FRONTING.has(roadClass)) ?? null
}

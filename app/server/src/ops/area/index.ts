import { z } from 'zod'
import { Assumptions, defineOp, requireProperty } from '../op.ts'
import { AREA_GROUPS, type AreaGroup } from './categories.ts'
import { AREA_REACH_M } from './cells.ts'
import { withArea } from './db.ts'
import { frontingStreet, placesNear, ROAD_CLASSES, roadsNear } from './query.ts'

const DETAIL_ROWS = 500

const propertyId = z.string().describe('A property id from GET /api/properties.')
const radiusM = z.int().min(50).max(AREA_REACH_M).default(800).describe('The search radius in metres. 800 m is about a ten-minute walk.')
const limit = z.int().min(1).max(25).default(10)
const name = z.string().trim().min(2).max(60).optional().describe('Keeps only names that contain this text, ignoring case.')
const Group = z.enum(AREA_GROUPS)
const RoadClass = z.enum(ROAD_CLASSES)
const distanceM = z.int().min(0)
const bearingDeg = z.int().min(0).max(359).describe('From the property, clockwise from north, within a degree.')

const assumptions = (radius: number) => [
  `A straight line of ${radius} m stands in for travel distance.`,
  'Places and roads come from Overture release 2026-10-21.0.',
]

// Keeps the rows whose name contains `text`, ignoring case, or every row without it.
const named = <T extends { name: string }>(rows: T[], text: string | undefined) =>
  text ? rows.filter((row) => row.name.toLowerCase().includes(text.toLowerCase())) : rows

const Place = z.object({ name: z.string(), group: Group, category: z.string().describe('The Overture basic category.'), distanceM, bearingDeg })

export const areaPlaces = defineOp({
  name: 'area_places',
  summary: 'Named places near a property, such as restaurants, schools or transit, nearest first, with distance and direction.',
  effect: 'read',
  input: z.object({ propertyId, group: Group.optional(), name, radiusM, limit }),
  output: z.object({
    places: z.array(Place),
    total: z.int().min(0).describe('Every matching place in the radius, before the limit.'),
    radiusM: z.int(),
    source: z.literal('overture'),
    assumptions: Assumptions,
  }),
  detail: z.object({ places: z.array(Place.extend({ lat: z.number(), lon: z.number() })).describe(`Up to ${DETAIL_ROWS}, nearest first.`) }),
})(async (ctx, input) => {
  const { lat, lon } = requireProperty(ctx, input.propertyId)
  const near = await withArea(ctx.dataDir, (db) => placesNear(db, { lat, lon }, input.radiusM))
  const matching = named(input.group ? near.filter((place) => place.group === input.group) : near, input.name)
  return {
    result: {
      places: matching.slice(0, input.limit).map(({ lat, lon, ...place }) => place),
      total: matching.length,
      radiusM: input.radiusM,
      source: 'overture',
      assumptions: assumptions(input.radiusM),
    },
    detail: { places: matching.slice(0, DETAIL_ROWS) },
  }
})

const Road = z.object({ name: z.string(), roadClass: RoadClass, distanceM, bearingDeg })

export const areaRoads = defineOp({
  name: 'area_roads',
  summary: 'Named roads near a property, such as motorways or residential streets, nearest first, with distance and direction.',
  effect: 'read',
  input: z.object({
    propertyId,
    roadClass: RoadClass.optional().describe('Keeps only this Overture road class. A motorway is a freeway.'),
    name,
    radiusM,
    limit,
  }),
  output: z.object({
    roads: z.array(Road).describe('One entry per road name and class, measured to its nearest point.'),
    total: z.int().min(0).describe('Every matching road in the radius, before the limit.'),
    radiusM: z.int(),
    source: z.literal('overture'),
    assumptions: Assumptions,
  }),
  detail: z.object({ roads: z.array(Road).describe(`Up to ${DETAIL_ROWS}, nearest first.`) }),
})(async (ctx, input) => {
  const { lat, lon } = requireProperty(ctx, input.propertyId)
  const near = await withArea(ctx.dataDir, (db) => roadsNear(db, { lat, lon }, input.radiusM))
  const matching = named(
    near.flatMap((road) => {
      const roadClass = RoadClass.safeParse(road.roadClass)
      return roadClass.success && (!input.roadClass || roadClass.data === input.roadClass) ? [{ ...road, roadClass: roadClass.data }] : []
    }),
    input.name,
  )
  return {
    result: {
      roads: matching.slice(0, input.limit),
      total: matching.length,
      radiusM: input.radiusM,
      source: 'overture',
      assumptions: [...assumptions(input.radiusM), 'Roads without a name are left out.'],
    },
    detail: { roads: matching.slice(0, DETAIL_ROWS) },
  }
})

export const areaSummary = defineOp({
  name: 'area_summary',
  summary: 'Counts of nearby places by group, the nearest of each and the street the property fronts.',
  effect: 'read',
  input: z.object({ propertyId, radiusM }),
  output: z.object({
    counts: z.record(Group, z.int().min(0)).describe('Places per group in the radius, zeros included.'),
    nearest: z.array(z.object({ group: Group, name: z.string(), distanceM })).describe('Groups with no place in the radius are left out.'),
    frontingStreet: z
      .object({ name: z.string(), roadClass: z.string(), distanceM, bearingDeg })
      .nullable()
      .describe('The nearest named street a building can face, within 150 m, or null.'),
    radiusM: z.int(),
    source: z.literal('overture'),
    assumptions: Assumptions,
  }),
})(async (ctx, { propertyId, radiusM }) => {
  const { lat, lon } = requireProperty(ctx, propertyId)
  const point = { lat, lon }
  const [near, street] = await withArea(ctx.dataDir, async (db) => [await placesNear(db, point, radiusM), await frontingStreet(db, point)] as const)
  return {
    result: {
      counts: Object.fromEntries(AREA_GROUPS.map((group) => [group, near.filter((place) => place.group === group).length])) as Record<AreaGroup, number>,
      nearest: AREA_GROUPS.flatMap((group) => {
        const first = near.find((place) => place.group === group)
        return first ? [{ group, name: first.name, distanceM: first.distanceM }] : []
      }),
      frontingStreet: street,
      radiusM,
      source: 'overture',
      assumptions: assumptions(radiusM),
    },
  }
})

export const AREA_OPS = [areaPlaces, areaRoads, areaSummary]

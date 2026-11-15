import { z } from 'zod'
import { Assumptions, defineOp, requireProperty } from '../op.ts'
import { AREA_GROUPS, type AreaGroup } from './categories.ts'
import { withArea } from './db.ts'
import { FrontingStreet, frontingStreet, placesNear } from './query.ts'

const DETAIL_PLACES = 500

const propertyId = z.string().describe('A property id from GET /api/properties.')
const radiusM = z.int().min(50).max(1000).default(800).describe('The search radius in metres.')
const Group = z.enum(AREA_GROUPS)

const assumptions = (radius: number) => [
  `A straight line of ${radius} m stands in for walking distance, and 800 m is about a ten-minute walk.`,
  'Places and streets come from Overture release 2026-10-21.0.',
]

const Place = z.object({
  name: z.string(),
  group: Group,
  category: z.string().describe('The Overture basic category.'),
  distanceM: z.int().min(0),
  bearingDeg: z.int().min(0).max(359).describe('From the property to the place, clockwise from north, within a degree.'),
})

export const areaPlaces = defineOp({
  name: 'area_places',
  summary: 'Places near a property, nearest first, by category group, with their distance and bearing.',
  effect: 'read',
  input: z.object({ propertyId, group: Group.optional(), radiusM, limit: z.int().min(1).max(25).default(10) }),
  output: z.object({
    places: z.array(Place),
    total: z.int().min(0).describe('Every matching place in the radius, before the limit.'),
    radiusM: z.int(),
    source: z.literal('overture'),
    assumptions: Assumptions,
  }),
  detail: z.object({ places: z.array(Place.extend({ lat: z.number(), lon: z.number() })).describe(`Up to ${DETAIL_PLACES}, nearest first.`) }),
})(async (ctx, { propertyId, group, radiusM, limit }) => {
  const { lat, lon } = requireProperty(ctx, propertyId)
  const near = await withArea(ctx.dataDir, (db) => placesNear(db, { lat, lon }, radiusM))
  const matching = group ? near.filter((place) => place.group === group) : near
  return {
    result: {
      places: matching.slice(0, limit).map(({ lat, lon, ...place }) => place),
      total: matching.length,
      radiusM,
      source: 'overture',
      assumptions: assumptions(radiusM),
    },
    detail: { places: matching.slice(0, DETAIL_PLACES) },
  }
})

export const areaSummary = defineOp({
  name: 'area_summary',
  summary: 'Counts of nearby places by group, the nearest place of each group and the street the property fronts.',
  effect: 'read',
  input: z.object({ propertyId, radiusM }),
  output: z.object({
    counts: z.record(Group, z.int().min(0)).describe('Places per group in the radius, zeros included.'),
    nearest: z.array(z.object({ group: Group, name: z.string(), distanceM: z.int().min(0) })).describe('Groups with no place in the radius are left out.'),
    frontingStreet: FrontingStreet.describe('The nearest named street a building can face, within 150 m, or null.'),
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

export const AREA_OPS = [areaPlaces, areaSummary]

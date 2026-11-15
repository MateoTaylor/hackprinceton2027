import { z } from 'zod'
import { stubOp } from '../op.ts'

const propertyId = z.string().describe('A property id from GET /api/properties.')
const radiusM = z.int().min(50).max(1000).default(800).describe('The search radius in metres.')

const areaPlaces = stubOp({
  name: 'area_places',
  summary: 'Places near a property, nearest first, by category group, with their distance and bearing.',
  effect: 'read',
  input: z.object({
    propertyId,
    group: z.enum(['food', 'grocery', 'transit', 'health', 'school', 'park', 'bank', 'fuel']).optional(),
    radiusM,
    limit: z.int().min(1).max(25).default(10),
  }),
})

const areaSummary = stubOp({
  name: 'area_summary',
  summary: 'Counts of nearby places by group, the nearest place of each key group and the street the property fronts.',
  effect: 'read',
  input: z.object({ propertyId, radiusM }),
})

export const AREA_OPS = [areaPlaces, areaSummary]

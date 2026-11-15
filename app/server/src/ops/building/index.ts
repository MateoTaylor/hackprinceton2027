import { z } from 'zod'
import { stubOp } from '../op.ts'

const buildingGet = stubOp({
  name: 'building_get',
  summary: 'The building model of a property: its shell, storeys, spaces, doors and furnishings.',
  effect: 'read',
  input: z.object({ propertyId: z.string().describe('A property id from GET /api/properties, such as "commercial-248243".') }),
})

export const BUILDING_OPS = [buildingGet]

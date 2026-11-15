import { z } from 'zod'
import { stubOp } from '../op.ts'

const featuresGet = stubOp({
  name: 'features_get',
  summary: 'The Vexcel attributes of a property from its newest capture, such as roof, pool and solar, by group.',
  effect: 'read',
  input: z.object({ propertyId: z.string().describe('A property id from GET /api/properties.') }),
})

export const FEATURES_OPS = [featuresGet]

import { z } from 'zod'
import { stubOp } from '../op.ts'

const routeSolve = stubOp({
  name: 'route_solve',
  summary: 'The best route from the street to a space or point for a payload, with a verdict on every door it passes.',
  effect: 'read',
  input: z.object({
    propertyId: z.string().describe('A property id from GET /api/properties.'),
    target: z
      .union([z.object({ spaceId: z.string() }), z.object({ at: z.tuple([z.number(), z.number()]) })])
      .describe('A space id from building_get, or a point [x, y] in metres on a storey.'),
    storeyIndex: z.int().min(0).optional().describe('The storey of an { at } target.'),
    payload: z.enum(['person', 'wheelchair', 'pallet_jack', 'scissor_lift', 'grand_piano', 'custom']),
    widthM: z.number().positive().optional().describe('The width of a custom payload in metres.'),
    heightM: z.number().positive().optional().describe('The height of a custom payload in metres.'),
  }),
})

export const ROUTE_OPS = [routeSolve]

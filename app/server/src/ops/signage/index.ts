import { z } from 'zod'
import { stubOp } from '../op.ts'

const liftChoose = stubOp({
  name: 'lift_choose',
  summary: 'The smallest lift class that reaches a working height and outreach on the given ground.',
  effect: 'read',
  input: z.object({
    heightM: z.number().positive().describe('The working height to reach in metres.'),
    outreachM: z.number().min(0).default(0).describe('The sideways reach in metres.'),
    ground: z.enum(['paved', 'unpaved']).default('paved'),
    overObstacle: z.boolean().default(false).describe('Whether the lift must reach up and over something.'),
  }),
})

const signageMeasure = stubOp({
  name: 'signage_measure',
  summary: 'The size of a placed sign, its height above the ground and the lift that reaches it.',
  effect: 'read',
  input: z.object({
    spaceId: z.string().regex(/^[A-Za-z0-9]{11}$/).describe('A Matterport model id from property_get scans.'),
    objectId: z.string().describe('A placed sign id from scene_get.'),
  }),
})

export const SIGNAGE_OPS = [liftChoose, signageMeasure]

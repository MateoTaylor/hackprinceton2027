import { z } from 'zod'
import { stubOp } from '../op.ts'

const propertyId = z.string().describe('A property id from GET /api/properties.')
const id = z.string().regex(/^[A-Za-z0-9_-]+$/)

const editPlaces = stubOp({
  name: 'edit_places',
  summary: 'The scans of a property that the edit API can edit, with their panoramas.',
  effect: 'read',
  input: z.object({ propertyId }),
})

const editStart = stubOp({
  name: 'edit_start',
  summary: 'Start a remove or retexture edit from a panorama, a view and a command. Poll edit_get with the job id.',
  effect: 'write',
  input: z.object({
    propertyId,
    modelId: id.describe('A scan id from edit_places.'),
    panoId: id.describe('A panorama id from edit_places.'),
    yawDeg: z.number(),
    pitchDeg: z.number().min(-89).max(89),
    fovDeg: z.number().min(30).max(120).default(70),
    command: z.string().min(3).max(300).describe('What to change, such as "remove the sofa".'),
    preset: z.enum(['720', 'fast', 'draft', 'quality']).optional(),
  }),
})

const editGet = stubOp({
  name: 'edit_get',
  summary: 'The status of an edit and, once it ends, its verdict and changed panoramas. Poll it until the status ends.',
  effect: 'read',
  input: z.object({ jobId: id.describe('The job id from edit_start.') }),
})

export const EDIT_OPS = [editPlaces, editStart, editGet]

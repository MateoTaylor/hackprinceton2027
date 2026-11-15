import { z } from 'zod'
import { stubOp } from '../op.ts'

const spaceId = z.string().regex(/^[A-Za-z0-9]{11}$/).describe('A Matterport model id from property_get scans.')
const position = z.tuple([z.number(), z.number(), z.number()]).describe('[x, y, z] in metres in the scan frame.')
const yawDeg = z.number().optional().describe('The turn about the vertical axis in degrees.')
const objectId = z.string().describe('A placed object id from scene_get.')
const expectedVersion = z.int().min(0).optional().describe('The scene version from scene_get. A newer scene answers conflict.')

const sceneGet = stubOp({
  name: 'scene_get',
  summary: 'The objects placed in a scan, with their poses and the scene version.',
  effect: 'read',
  input: z.object({ spaceId }),
})

const scenePlace = stubOp({
  name: 'scene_place',
  summary: 'Place an equipment item in a scan at a position, or on a floor, wall or ceiling anchor.',
  effect: 'write',
  input: z.object({
    spaceId,
    equipmentId: z.string().describe('A placeable item id from equipment_list.'),
    position,
    yawDeg,
    anchor: z
      .object({ kind: z.enum(['floor', 'wall', 'ceiling']), normal: z.tuple([z.number(), z.number(), z.number()]) })
      .optional()
      .describe('The surface the item sits on and its outward normal.'),
    expectedVersion,
  }),
})

const sceneMove = stubOp({
  name: 'scene_move',
  summary: 'Move or rotate an object placed in a scan.',
  effect: 'write',
  input: z.object({ spaceId, objectId, position: position.optional(), yawDeg, expectedVersion }),
})

const sceneRemove = stubOp({
  name: 'scene_remove',
  summary: 'Remove an object placed in a scan.',
  effect: 'write',
  input: z.object({ spaceId, objectId, expectedVersion }),
})

export const SCENE_OPS = [sceneGet, scenePlace, sceneMove, sceneRemove]

import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { EQUIPMENT, isPlaceable } from '../../model/equipment.ts'
import { Assumptions, defineOp, OpError, type OpContext } from '../op.ts'
import { Anchor, readScene, SceneObject, SizeM, SpaceId, withSceneLock, writeScene, type SceneDocument } from './document.ts'

// The most objects one scan holds. A full scene of signs must still fit in RESULT_MAX_CHARS.
export const MAX_OBJECTS = 25

const coordinate = z.number().min(-1000).max(1000)
const position = z.tuple([coordinate, coordinate, coordinate]).describe('[x, y, z] in metres in the scan frame, Y up.')
const yawDeg = z.number().optional().describe('The turn about the vertical axis in degrees. A wall object faces along its wall normal when this is left out.')
const objectId = z.string().describe('A placed object id from scene_get.')
const expectedVersion = z.int().min(0).optional().describe('The scene version from scene_get. A newer scene answers conflict.')
const anchor = Anchor.optional().describe('The surface the item sits on and its outward normal.')
const sizeM = SizeM.optional().describe('The face of a sign in metres. Only a sign takes a size.')
const groundY = coordinate.optional().describe('The height of the ground under a sign, in the scan frame.')

const SceneResult = z.object({
  spaceId: SpaceId,
  version: z.int(),
  objectCount: z.int(),
  objects: z.array(SceneObject),
  assumptions: Assumptions,
})

const result = ({ spaceId, version, objects }: SceneDocument): z.input<typeof SceneResult> => ({
  spaceId,
  version,
  objectCount: objects.length,
  objects,
  assumptions: ['Positions are in the scan frame in metres with Y up.'],
})

// Reads the scene, lets `change` edit it, and saves it one version higher. A stale
// `expectedVersion` answers `conflict` and saves nothing.
function write(ctx: OpContext, spaceId: string, expected: number | undefined, change: (scene: SceneDocument) => void) {
  return withSceneLock(spaceId, async () => {
    const scene = await readScene(ctx.dataDir, spaceId)
    if (expected !== undefined && expected !== scene.version) {
      throw new OpError('conflict', 'The scene changed since you read it.', `The scene is at version ${scene.version}. Call scene_get and retry with expectedVersion ${scene.version}.`)
    }
    change(scene)
    scene.version += 1
    await writeScene(ctx.dataDir, scene)
    return { result: result(scene) }
  })
}

function requireEquipment(equipmentId: string) {
  const row = EQUIPMENT.find(({ id }) => id === equipmentId)
  if (!row || !isPlaceable(row)) throw new OpError('invalid_input', `"${equipmentId}" is not a placeable item.`, 'List the placeable ids with equipment_list.')
  return row
}

function requireObject(scene: SceneDocument, id: string) {
  const object = scene.objects.find((candidate) => candidate.id === id)
  if (!object) throw new OpError('not_found', `No placed object has the id "${id}".`, 'List the placed objects with scene_get.')
  return object
}

// Checks an object against its equipment row and returns it in stored form.
function checked(object: z.input<typeof SceneObject>) {
  const row = requireEquipment(object.equipmentId)
  if (row.mount === 'wall' && !object.anchor) throw new OpError('invalid_input', `${row.label} hangs on a wall.`, 'Send anchor with kind "wall" and the wall normal.')
  if (object.anchor && object.anchor.kind !== row.mount) {
    throw new OpError('invalid_input', `${row.label} sits on a ${row.mount}, not a ${object.anchor.kind}.`, `Send an anchor of kind "${row.mount}".`)
  }
  if (object.anchor?.kind === 'wall' && !isWallNormal(object.anchor.normal)) {
    throw new OpError('invalid_input', 'A wall normal must be close to horizontal.', 'Send the outward normal of the wall, such as [1, 0, 0].')
  }
  if (object.sizeM && row.class !== 'sign') throw new OpError('invalid_input', `${row.label} has a fixed size.`, 'Leave sizeM out. Only a sign takes a size.')
  const sized = row.class === 'sign' && !object.sizeM ? { ...object, sizeM: { widthM: row.lengthM ?? 1, heightM: row.stowedHeightM ?? 1 } } : object
  return SceneObject.parse({ ...sized, yawDeg: normalYaw(sized.yawDeg) })
}

// Whether a normal is within 20 degrees of horizontal, the same test the browser uses for a wall.
const isWallNormal = ([x, y, z]: readonly number[]) => Math.hypot(x, y, z) > 0 && Math.abs(y) / Math.hypot(x, y, z) <= 0.342

const normalYaw = (deg: number) => Math.round((((deg % 360) + 360) % 360) * 10) / 10 % 360

// The yaw that turns an object's +X axis along a horizontal normal.
const yawFromNormal = ([x, , z]: readonly number[]) => (Math.atan2(-z, x) * 180) / Math.PI

const sceneGet = defineOp({
  name: 'scene_get',
  summary: 'The objects placed in a scan, with their poses and the scene version.',
  effect: 'read',
  input: z.object({ spaceId: SpaceId }),
  output: SceneResult,
})(async (ctx, { spaceId }) => ({ result: result(await readScene(ctx.dataDir, spaceId)) }))

const scenePlace = defineOp({
  name: 'scene_place',
  summary: 'Place an equipment item in a scan at a position, or on a floor, wall or ceiling anchor.',
  effect: 'write',
  input: z.object({ spaceId: SpaceId, equipmentId: z.string().describe('A placeable item id from equipment_list.'), position, yawDeg, anchor, sizeM, groundY, expectedVersion }),
  output: SceneResult,
})((ctx, { spaceId, expectedVersion, yawDeg, ...placed }) =>
  write(ctx, spaceId, expectedVersion, (scene) => {
    if (scene.objects.length >= MAX_OBJECTS) throw new OpError('invalid_input', `A scan holds at most ${MAX_OBJECTS} objects.`, 'Remove an object with scene_remove first.')
    const yaw = yawDeg ?? (placed.anchor?.kind === 'wall' ? yawFromNormal(placed.anchor.normal) : 0)
    scene.objects.push(checked({ ...placed, id: `o-${randomBytes(4).toString('hex')}`, yawDeg: yaw }))
  }),
)

const sceneMove = defineOp({
  name: 'scene_move',
  summary: 'Move, turn or resize an object placed in a scan.',
  effect: 'write',
  input: z.object({ spaceId: SpaceId, objectId, position: position.optional(), yawDeg, anchor, sizeM, groundY, expectedVersion }),
  output: SceneResult,
})((ctx, { spaceId, objectId, expectedVersion, ...change }) =>
  write(ctx, spaceId, expectedVersion, (scene) => {
    const object = requireObject(scene, objectId)
    scene.objects[scene.objects.indexOf(object)] = checked({
      ...object,
      position: change.position ?? object.position,
      anchor: change.anchor ?? object.anchor,
      sizeM: change.sizeM ?? object.sizeM,
      // The measured ground belongs to the old spot, so a move without a new one drops it.
      groundY: change.groundY ?? (change.position ? undefined : object.groundY),
      yawDeg: change.yawDeg ?? (change.anchor?.kind === 'wall' ? yawFromNormal(change.anchor.normal) : object.yawDeg),
    })
  }),
)

const sceneRemove = defineOp({
  name: 'scene_remove',
  summary: 'Remove an object placed in a scan.',
  effect: 'write',
  input: z.object({ spaceId: SpaceId, objectId, expectedVersion }),
  output: SceneResult,
})((ctx, { spaceId, objectId, expectedVersion }) =>
  write(ctx, spaceId, expectedVersion, (scene) => {
    scene.objects.splice(scene.objects.indexOf(requireObject(scene, objectId)), 1)
  }),
)

export const SCENE_OPS = [sceneGet, scenePlace, sceneMove, sceneRemove]

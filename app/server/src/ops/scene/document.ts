import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

const round = (places: number) => (value: number) => Math.round(value * 10 ** places) / 10 ** places
const metres = z.number().overwrite(round(2))
const Vec3 = z.tuple([metres, metres, metres])

export const SpaceId = z.string().regex(/^[A-Za-z0-9]{11}$/).describe('A Matterport model id from property_get scans.')

// The surface an object sits on and that surface's outward unit normal.
export const Anchor = z.object({
  kind: z.enum(['floor', 'wall', 'ceiling']),
  normal: z.tuple([z.number(), z.number(), z.number()]).overwrite(([x, y, z]) => {
    const length = Math.hypot(x, y, z) || 1
    const unit = round(3)
    return [unit(x / length), unit(y / length), unit(z / length)]
  }),
})

// The face of a sign in metres.
export const SizeM = z.object({ widthM: z.number().min(0.2).max(20).overwrite(round(2)), heightM: z.number().min(0.2).max(20).overwrite(round(2)) })

// One placed object, in the scan's frame: metres, Y up. `position` is the centre of the back face
// for a wall object and the centre of the footprint for a floor object. `groundY` is the height of
// the ground under a sign, measured on the scan mesh by the browser.
export const SceneObject = z.object({
  id: z.string(),
  equipmentId: z.string(),
  position: Vec3,
  yawDeg: z.number(),
  anchor: Anchor.optional(),
  sizeM: SizeM.optional(),
  groundY: metres.optional(),
})
export type SceneObject = z.infer<typeof SceneObject>

export const SceneDocument = z.object({ spaceId: SpaceId, version: z.int().min(0), objects: z.array(SceneObject) })
export type SceneDocument = z.infer<typeof SceneDocument>

const scenePath = (dataDir: string, spaceId: string) => join(dataDir, 'scenes', `${spaceId}.json`)

// The saved scene for a space, or an empty one at version 0. `spaceId` must already match SpaceId,
// because it becomes a file name.
export async function readScene(dataDir: string, spaceId: string): Promise<SceneDocument> {
  const text = await readFile(scenePath(dataDir, spaceId), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  return text === null ? { spaceId, version: 0, objects: [] } : SceneDocument.parse(JSON.parse(text))
}

// Replaces the saved scene in one step, so a reader never sees half a file.
export async function writeScene(dataDir: string, scene: SceneDocument) {
  const path = scenePath(dataDir, scene.spaceId)
  await mkdir(join(dataDir, 'scenes'), { recursive: true })
  await writeFile(`${path}.tmp`, JSON.stringify(scene))
  await rename(`${path}.tmp`, path)
}

const locks = new Map<string, Promise<unknown>>()

// Runs `fn` after every earlier write to the same space has finished, so two writes cannot both
// read the same version.
export function withSceneLock<T>(spaceId: string, fn: () => Promise<T>): Promise<T> {
  const run = (locks.get(spaceId) ?? Promise.resolve()).then(fn, fn)
  locks.set(spaceId, run.catch(() => {}))
  return run
}

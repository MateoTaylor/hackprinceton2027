import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
const round2 = (value: number) => Math.round(value * 100) / 100
const metres = z.number().overwrite(round2)

// The face of a sign in metres. Only the wall it hangs on bounds it from above (see `misfit`).
export const SizeM = z.object({ widthM: z.number().min(0.2).overwrite(round2), heightM: z.number().min(0.2).overwrite(round2) })

// One blank sign on an outside wall, in the building's frame and independent of any photo. The
// wall is `wallIndex` from signage_get, `alongM` is the sign's centre from that wall's start corner,
// and `bottomM` is its bottom edge above the ground.
export const Sign = z.object({ id: z.string(), wallIndex: z.int().min(0), alongM: metres, bottomM: metres, sizeM: SizeM })
export type Sign = z.infer<typeof Sign>

export const SignDocument = z.object({ propertyId: z.string(), version: z.int().min(0), signs: z.array(Sign) })
export type SignDocument = z.infer<typeof SignDocument>

const signsPath = (dataDir: string, propertyId: string) => join(dataDir, 'signs', `${propertyId}.json`)

// The saved signs of a property, or none at version 0. `propertyId` must be a known property id,
// because it becomes a file name.
export async function readSigns(dataDir: string, propertyId: string): Promise<SignDocument> {
  const text = await readFile(signsPath(dataDir, propertyId), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  return text === null ? { propertyId, version: 0, signs: [] } : SignDocument.parse(JSON.parse(text))
}

// Replaces the saved signs in one step, so a reader never sees half a file.
export async function writeSigns(dataDir: string, document: SignDocument) {
  const path = signsPath(dataDir, document.propertyId)
  await mkdir(join(dataDir, 'signs'), { recursive: true })
  await writeFile(`${path}.tmp`, JSON.stringify(document))
  await rename(`${path}.tmp`, path)
}

const locks = new Map<string, Promise<unknown>>()

// Runs `fn` after every earlier write to the same property's signs has finished, so two writes
// cannot both read the same version.
export function withSignLock<T>(propertyId: string, fn: () => Promise<T>): Promise<T> {
  const run = (locks.get(propertyId) ?? Promise.resolve()).then(fn, fn)
  locks.set(propertyId, run.catch(() => {}))
  return run
}

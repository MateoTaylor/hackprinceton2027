import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { SizeM } from '../scene/document.ts'

const metres = z.number().overwrite((value) => Math.round(value * 100) / 100)

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

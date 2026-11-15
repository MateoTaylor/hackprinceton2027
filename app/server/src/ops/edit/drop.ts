import { readdir, readFile, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { z } from 'zod'

// The two demo tools. `erase` is the Magic Eraser and `remodel` retextures a surface.
export const EDIT_TOOLS = ['erase', 'remodel'] as const
export type EditTool = (typeof EDIT_TOOLS)[number]

// A property id or edit id that is safe to use as one folder name.
export const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/

// A picture's file name inside a property's drop folder: no folder part, no leading dot, an image
// extension the picture route knows.
export const PICTURE_NAME = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,120}\.(png|jpe?g|webp)$/i

const PreparedEdit = z.object({
  id: z.string().regex(SAFE_ID),
  tool: z.enum(EDIT_TOOLS),
  command: z.string().min(3).max(200),
  where: z.string().min(1).max(80).optional(),
  before: z.string().regex(PICTURE_NAME),
  after: z.string().regex(PICTURE_NAME),
})
export type PreparedEdit = z.infer<typeof PreparedEdit>

// The shape of `manifest.json` in a property's drop folder. The README beside this file is its
// contract for whoever prepares the pictures.
export const Manifest = z.object({
  edits: z
    .array(PreparedEdit)
    .min(1)
    .max(20)
    .refine((edits) => new Set(edits.map(({ id }) => id)).size === edits.length, 'Edit ids must be unique.'),
})

// Where every property's drop folder lives, under the server's data folder.
export const dropRoot = (dataDir: string) => join(dataDir, 'edits')

// Why a drop folder could not be read. `missing` means the property has no folder, `invalid` that
// its manifest does not parse, and `incomplete` that a picture it names is not on disk.
export type DropProblem = 'missing' | 'invalid' | 'incomplete'

// Reads and checks one property's drop folder. Resolves to the prepared edits, or to the problem.
//   const drop = await readDrop(ctx.dataDir, propertyId)
//   if ('problem' in drop) ...
export async function readDrop(dataDir: string, propertyId: string): Promise<{ edits: PreparedEdit[] } | { problem: DropProblem }> {
  if (!SAFE_ID.test(propertyId)) return { problem: 'missing' }
  const folder = join(dropRoot(dataDir), propertyId)
  const text = await readFile(join(folder, 'manifest.json'), 'utf8').catch(() => null)
  if (text === null) return { problem: 'missing' }
  const parsed = Manifest.safeParse(parseJson(text))
  if (!parsed.success) return { problem: 'invalid' }
  const names = parsed.data.edits.flatMap(({ before, after }) => [before, after])
  const present = await Promise.all(names.map((name) => stat(join(folder, name)).then((s) => s.isFile(), () => false)))
  return present.every(Boolean) ? { edits: parsed.data.edits } : { problem: 'incomplete' }
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

// The property ids that have a drop folder, for a hint that names where the demo works.
export const dropProperties = async (dataDir: string) =>
  (await readdir(dropRoot(dataDir), { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory() && SAFE_ID.test(entry.name))
    .map(({ name }) => name)
    .sort()

// Words that say what to do rather than what to change, so "erase the lamp" and "remove the
// floor lamp" compare on "lamp" and "floor lamp".
const FILLER = new Set(
  'a an and any are at be by can could do for from get give i in into is it its like make me my new of on our out please put rid set some that the their them these this those to turn up us use want we with would you change replace swap paint retexture recolour recolor remove erase delete take away clear'.split(
    ' ',
  ),
)

const words = (text: string) => (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).map((word) => word.replace(/(?<=[a-z]{3})s$/, '')).filter((word) => !FILLER.has(word))

// The prepared edit of `tool` that `command` asks for, or null. An edit matches when the words of
// one command all appear in the other, once filler words and plural s are dropped. The edit with
// the most words in common wins, so "change the floor to light oak" beats a plain "floor" edit.
export function matchCommand(edits: readonly PreparedEdit[], tool: EditTool, command: string): PreparedEdit | null {
  const asked = new Set(words(command))
  if (!asked.size) return null
  let best: { edit: PreparedEdit; shared: number } | null = null
  for (const edit of edits) {
    if (edit.tool !== tool) continue
    const wanted = new Set(words(edit.command))
    const shared = [...wanted].filter((word) => asked.has(word)).length
    const contained = shared > 0 && (shared === wanted.size || shared === asked.size)
    if (contained && shared > (best?.shared ?? 0)) best = { edit, shared }
  }
  return best?.edit ?? null
}

// The file on disk for a picture request, or null when the property id or file name could reach
// outside the drop folder.
export function picturePath(dataDir: string, propertyId: string, file: string): string | null {
  if (!SAFE_ID.test(propertyId) || !PICTURE_NAME.test(file) || file.includes('..')) return null
  const root = resolve(dropRoot(dataDir))
  const path = resolve(root, propertyId, file)
  return path.startsWith(root + sep) ? path : null
}

// The URL the picture route serves a drop-folder picture at.
export const pictureUrl = (propertyId: string, file: string) => `/api/edits/${encodeURIComponent(propertyId)}/${encodeURIComponent(file)}`

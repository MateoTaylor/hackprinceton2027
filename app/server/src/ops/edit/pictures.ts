import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import type { Context } from 'hono'
import { picturePath } from './drop.ts'

// The route the drop-folder pictures are served at. pictureUrl in drop.ts builds its URLs.
export const PICTURE_ROUTE = '/api/edits/:propertyId/:file'

const TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }

// A Hono handler that serves one picture from a property's drop folder under `dataDir`. Mount it
// on PICTURE_ROUTE behind the app's localhost guard:
//   app.get(PICTURE_ROUTE, servePicture(base.dataDir))
// A name that could leave the folder answers 400, and a missing file 404. Pictures are not cached,
// so a picture swapped in the drop folder shows on the next run.
export const servePicture = (dataDir: string) => async (c: Context) => {
  const path = picturePath(dataDir, c.req.param('propertyId') ?? '', c.req.param('file') ?? '')
  if (!path) return c.json({ error: 'Bad picture name' }, 400)
  const body = await readFile(path).catch(() => null)
  if (!body) return c.json({ error: 'No such picture' }, 404)
  return c.body(body, 200, {
    'Content-Type': TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  })
}

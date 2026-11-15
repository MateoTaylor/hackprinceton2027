import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context, Hono } from 'hono'
import type { RenderSlides } from '../../shared/api.ts'

// Mateo's finished scan edits in `demo_renders/<place>/` (see its README). Each place has an
// `edits.json` naming its Matterport model and edit folders, and each edit folder has the edit
// API's `edit.json`, whose `panos[].views[]` name a flat before and after picture.
type EditsFile = { model_id: string; edits: { name: string; command: string }[] }
type EditFile = {
  panos: { id: string; views: { before: string; edited: string; mask: string; yaw: number; pitch: number; fov: number; width: number; height: number }[] }[]
}

const NAME = /^[\w-]+$/
const FILE = /^[\w-]+\.(jpg|png)$/

// Mounts the renders under `root` (the repo's `demo_renders/`):
//   GET /api/renders/:modelId              -> RenderSlides, the before/after pairs per sweep
//   GET /api/renders/:modelId/:edit/:file  -> one picture
// A model with no renders answers an empty `sweeps`. The folder is read on every call.
export function mountRenders(app: Hono, root: string) {
  app.get('/api/renders/:modelId', async (c) => {
    const place = await findPlace(root, c.req.param('modelId'))
    return c.json<RenderSlides>({ sweeps: place ? await slides(place.dir, place.edits, c.req.path) : {} })
  })

  app.get('/api/renders/:modelId/:edit/:file', async (c: Context) => {
    const edit = c.req.param('edit') ?? ''
    const file = c.req.param('file') ?? ''
    const place = await findPlace(root, c.req.param('modelId') ?? '')
    if (!place || !NAME.test(edit) || !FILE.test(file) || !place.edits.edits.some((e) => e.name === edit)) {
      return c.json({ error: 'No such picture' }, 404)
    }
    const body = await readFile(join(place.dir, edit, file)).catch(() => null)
    if (!body) return c.json({ error: 'No such picture' }, 404)
    const type = file.endsWith('.png') ? 'image/png' : 'image/jpeg'
    return c.body(body, 200, { 'Content-Type': type, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' })
  })
}

async function findPlace(root: string, modelId: string) {
  const names = await readdir(root).catch(() => [])
  for (const name of names.filter((n) => NAME.test(n))) {
    const dir = join(root, name)
    const edits = await readJson<EditsFile>(join(dir, 'edits.json'))
    if (edits?.model_id === modelId) return { dir, edits }
  }
  return null
}

async function slides(dir: string, { edits }: EditsFile, base: string) {
  const sweeps: RenderSlides['sweeps'] = {}
  for (const { name, command } of edits) {
    const edit = await readJson<EditFile>(join(dir, name, 'edit.json'))
    for (const pano of edit?.panos ?? []) {
      for (const view of pano.views) {
        const { yaw, pitch, fov, width, height } = view
        const url = (file: string) => `${base}/${name}/${file}`
        ;(sweeps[pano.id] ??= []).push({
          command,
          before: url(view.before),
          after: url(view.edited),
          mask: url(view.mask),
          view: { yaw, pitch, fov, width, height },
        })
      }
    }
  }
  return sweeps
}

const readJson = async <T>(path: string) =>
  readFile(path, 'utf8')
    .then((text) => JSON.parse(text) as T)
    .catch(() => null)

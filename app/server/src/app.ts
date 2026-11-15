import { Hono, type Context } from 'hono'
import { logger } from 'hono/logger'
import type { ApiError } from '../../shared/api.ts'
import type { Cached } from './cache.ts'
import { forwardEdit } from './editProxy.ts'
import { PICTURE_ROUTE, servePicture } from './ops/edit/pictures.ts'
import { mountOps } from './ops/http.ts'
import { OPS, PROPPY_OPS } from './ops/index.ts'
import type { Op } from './ops/op.ts'
import { createRegistry, type OpBase } from './ops/registry.ts'
import { createViewOps } from './ops/view/index.ts'
import { mountView } from './view/routes.ts'
import { createViewStore, type ViewStore } from './view/store.ts'
import { isDirection, UpstreamError } from './vexcel.ts'

// Vexcel's `urban` layer, the one with obliques, stops at 21.
const MAX_ZOOM = 21

// Parses tile path params. Returns null unless z is an integer in 0..21 and x, y fall inside that
// zoom's grid.
export function parseTile(z: string, x: string, y: string) {
  const [zoom, col, row] = [z, x, y].map((s) => (/^\d{1,8}$/.test(s) ? Number(s) : -1))
  if (zoom < 0 || zoom > MAX_ZOOM) return null
  const size = 2 ** zoom
  if (col < 0 || col >= size || row < 0 || row >= size) return null
  return { z: zoom, x: col, y: row }
}

const error = (c: Context, status: 400 | 404 | 500 | 502 | 503, message: string) =>
  c.json<ApiError>({ error: message }, status)

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost'])

const IMAGE_CACHE = 'private, max-age=86400'

const image = (c: Context, answer: Cached) => {
  c.header('Cache-Control', IMAGE_CACHE)
  if (answer.status === 404) return error(c, 404, 'No imagery here')
  return c.body(answer.body, 200, { 'Content-Type': answer.contentType })
}

// The Propstar HTTP API. It answers only under /api; every other path is an empty 404, so nothing
// on disk can be served. It registers `ops` and throws when one of them is invalid. `sdkKey` is the
// Matterport SDK key the browser's Showcase embed needs, and /api/edit/* forwards to `editLink`.
// `view` is the one view the view ops and GET /api/events share; by default `ops` holds the public
// ops plus the view ops bound to it, served at /api/ops, and `proppyOps` holds Proppy's private ops,
// served the same way at /api/proppy/ops.
export function createApp({
  base,
  view = createViewStore(),
  ops = [...OPS, ...createViewOps(view)],
  proppyOps = PROPPY_OPS,
  sdkKey = null,
  editLink = {},
}: {
  base: OpBase
  view?: ViewStore
  ops?: readonly Op[]
  proppyOps?: readonly Op[]
  sdkKey?: string | null
  editLink?: Parameters<typeof forwardEdit>[1]
}) {
  const { properties, vexcel } = base
  const registry = createRegistry(ops, base)
  const proppyRegistry = createRegistry(proppyOps, base)
  const app = new Hono()

  app.use(logger())

  // Answers only requests addressed to this machine by name, so a page on a DNS-rebound domain cannot
  // read the API, and refuses cross-site browser requests. The URL hostname comes from the Host
  // header. The Vite proxy keeps Host as localhost:5173 and passes same-origin fetch metadata through.
  app.use(async (c, next) => {
    const { hostname } = new URL(c.req.url)
    if (!LOCAL_HOSTS.has(hostname) || c.req.header('sec-fetch-site') === 'cross-site') return c.body(null, 403)
    await next()
  })

  app.get('/api/properties', (c) => c.json([...properties.values()]))

  mountOps(app, registry, '/api/ops', view.publishWrite)
  mountOps(app, proppyRegistry, '/api/proppy/ops', view.publishWrite)
  mountView(app, view)

  app.get('/api/scene/config', (c) => {
    c.header('Cache-Control', 'no-store')
    if (!sdkKey) return error(c, 503, 'MP_SDK_KEY is missing from the repo-root .env')
    return c.json({ sdkKey })
  })

  app.all('/api/edit/*', (c) => forwardEdit(c.req.raw, editLink))

  app.get(PICTURE_ROUTE, servePicture(base.dataDir))

  app.get('/api/tiles/:z/:x/:y', async (c) => {
    const tile = parseTile(c.req.param('z'), c.req.param('x'), c.req.param('y'))
    if (!tile) return error(c, 400, 'Tile coordinates must be integers inside the grid of a zoom from 0 to 21')
    const answer = await vexcel.tile(tile.z, tile.x, tile.y)
    // Vexcel has no imagery over the ocean; MapLibre draws an empty 204 as a blank tile without logging an error.
    if (answer.status === 404) return c.body(null, 204, { 'Cache-Control': IMAGE_CACHE })
    return image(c, answer)
  })

  app.get('/api/thumb/:id', async (c) => {
    const property = properties.get(c.req.param('id'))
    if (!property) return error(c, 404, 'Unknown property')
    return image(c, await vexcel.thumb(property))
  })

  app.get('/api/oblique/:id', async (c) => {
    const property = properties.get(c.req.param('id'))
    if (!property) return error(c, 404, 'Unknown property')
    return c.json(await vexcel.obliqueIndex(property))
  })

  app.get('/api/oblique/:id/:dir', async (c) => {
    const property = properties.get(c.req.param('id'))
    if (!property) return error(c, 404, 'Unknown property')
    const dir = c.req.param('dir')
    if (!isDirection(dir)) return error(c, 400, 'Direction must be north, east, south or west')
    const { photo, pose } = await vexcel.oblique(property, dir)
    if (pose) c.header('X-Oblique-Pose', JSON.stringify(pose))
    return image(c, photo)
  })

  app.notFound((c) => c.body(null, 404))

  app.onError((err, c) => {
    if (err instanceof UpstreamError) {
      return err.status === 429 ? error(c, 503, 'Vexcel is rate limiting us; try again soon') : error(c, 502, 'Vexcel failed')
    }
    console.error(err)
    return error(c, 500, 'Internal error')
  })

  return app
}

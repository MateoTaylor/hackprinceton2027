import { Hono, type Context } from 'hono'
import { logger } from 'hono/logger'
import type { ApiError } from '../../shared/api.ts'
import type { Property } from '../../shared/property.ts'
import type { Cached } from './cache.ts'
import { isDirection, UpstreamError, type Vexcel } from './vexcel.ts'

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
// on disk can be served.
export function createApp({ properties, vexcel }: { properties: Property[]; vexcel: Vexcel }) {
  const byId = new Map(properties.map((p) => [p.id, p]))
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

  app.get('/api/properties', (c) => c.json(properties))

  app.get('/api/tiles/:z/:x/:y', async (c) => {
    const tile = parseTile(c.req.param('z'), c.req.param('x'), c.req.param('y'))
    if (!tile) return error(c, 400, 'Tile coordinates must be integers inside the grid of a zoom from 0 to 21')
    return image(c, await vexcel.tile(tile.z, tile.x, tile.y))
  })

  app.get('/api/thumb/:id', async (c) => {
    const property = byId.get(c.req.param('id'))
    if (!property) return error(c, 404, 'Unknown property')
    return image(c, await vexcel.thumb(property))
  })

  app.get('/api/oblique/:id', async (c) => {
    const property = byId.get(c.req.param('id'))
    if (!property) return error(c, 404, 'Unknown property')
    return c.json(await vexcel.obliqueIndex(property))
  })

  app.get('/api/oblique/:id/:dir', async (c) => {
    const property = byId.get(c.req.param('id'))
    if (!property) return error(c, 404, 'Unknown property')
    const dir = c.req.param('dir')
    if (!isDirection(dir)) return error(c, 400, 'Direction must be north, east, south or west')
    return image(c, await vexcel.oblique(property, dir))
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

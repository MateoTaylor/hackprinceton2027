import { z } from 'zod'
import type { Direction, ObliqueIndex } from '../../shared/api.ts'
import type { Property } from '../../shared/property.ts'
import type { Cached, DiskCache } from './cache.ts'

const BASE = 'https://api.vexcelgroup.com/v2'
// The fallback chain tools/smoke/smoke.ts uses: the API picks the best imagery available.
const LAYERS = 'urban,urban-r,wide-area,urban-g'
// Vexcel warns against parallel bursts and asks for 1, 2, 4, 8, 16 s backoff on 429. A map view
// gives up long before 31 s, so this stops after 7 s.
const MAX_CONCURRENT = 4
const BACKOFF_MS = [1000, 2000, 4000]
const TIMEOUT_MS = 30_000

const DIRECTION_ORDER = { north: 0, east: 1, south: 2, west: 3 } satisfies Record<Direction, number>

export const isDirection = (value: string): value is Direction => Object.hasOwn(DIRECTION_ORDER, value)

// Vexcel failed in a way worth retrying later. Carries only the upstream status, never its body.
export class UpstreamError extends Error {
  readonly status: number
  constructor(status: number) {
    super(`Vexcel answered ${status}`)
    this.status = status
  }
}

type UpstreamRequest = { path: string; query?: Record<string, string>; json?: Record<string, unknown> }

const Ring = z.array(z.array(z.number()))
const Geometry = z.discriminatedUnion('type', [
  z.object({ type: z.literal('Polygon'), coordinates: z.array(Ring) }),
  z.object({ type: z.literal('MultiPolygon'), coordinates: z.array(z.array(Ring)) }),
])
const ParcelResponse = z.object({
  features: z.array(
    z.object({ geometry: Geometry, properties: z.object({ 'metadata.ortho-date-estimate': z.string().nullish() }) }),
  ),
})
const CollectionsResponse = z.object({
  features: z.array(
    z.object({
      properties: z.object({ collection: z.string(), 'last-capture-date': z.string(), 'product-type': z.string() }),
    }),
  ),
})

type Geometry = z.infer<typeof Geometry>
const ring = (points: number[][]) => `(${points.map((p) => p.join(' ')).join(',')})`
const polygon = (rings: number[][][]) => `(${rings.map(ring).join(',')})`
const toWkt = (g: Geometry) =>
  g.type === 'Polygon' ? `POLYGON${polygon(g.coordinates)}` : `MULTIPOLYGON(${g.coordinates.map(polygon).join(',')})`

type Bounds = { west: number; south: number; east: number; north: number }
const boundsWkt = ({ west, south, east, north }: Bounds) =>
  `POLYGON((${west} ${south},${east} ${south},${east} ${north},${west} ${north},${west} ${south}))`

function boundsOf(g: Geometry): Bounds {
  const points = g.type === 'Polygon' ? g.coordinates.flat() : g.coordinates.flat(2)
  const lons = points.map((p) => p[0])
  const lats = points.map((p) => p[1])
  return { west: Math.min(...lons), south: Math.min(...lats), east: Math.max(...lons), north: Math.max(...lats) }
}

const M_PER_DEG_LAT = 111_320

// A box that is square on the ground, `half` metres from its centre to each edge.
function squareAround(lon: number, lat: number, half: number): Bounds {
  const dLat = half / M_PER_DEG_LAT
  const dLon = half / (M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180))
  return { west: lon - dLon, south: lat - dLat, east: lon + dLon, north: lat + dLat }
}

// The smallest box square on the ground that holds `b`, centred on it. A square ortho extract comes
// back at 256x256 without stretching.
export function squareBounds(b: Bounds) {
  const lat = (b.south + b.north) / 2
  const width = (b.east - b.west) * M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180)
  const height = (b.north - b.south) * M_PER_DEG_LAT
  return squareAround((b.west + b.east) / 2, lat, Math.max(width, height) / 2)
}

// A property's footprint: the exact outline for oriented extracts, and its bounds for the rest.
type Outline = { wkt: string; bounds: Bounds }

// `property/extract` returns one feature per capture, unsorted even with `latest=true`. A point with
// no parcel gets a 100 m square around it.
export function newestOutline(parcel: z.infer<typeof ParcelResponse> | null, { lon, lat }: Property): Outline {
  const newest = parcel?.features.toSorted((a, b) =>
    (b.properties['metadata.ortho-date-estimate'] ?? '').localeCompare(a.properties['metadata.ortho-date-estimate'] ?? ''),
  )[0]
  if (newest) return { wkt: toWkt(newest.geometry), bounds: boundsOf(newest.geometry) }
  const bounds = squareAround(lon, lat, 50)
  return { wkt: boundsWkt(bounds), bounds }
}

// One capture shows the building from every side on the same day, so only the newest collection
// counts, even when an older one covers a direction the newest lacks.
export function newestObliques({ features }: z.infer<typeof CollectionsResponse>) {
  const newest = features
    .map((f) => f.properties)
    .toSorted((a, b) => b['last-capture-date'].localeCompare(a['last-capture-date']))[0]
  if (!newest) return null
  const directions = features
    .filter((f) => f.properties.collection === newest.collection)
    .map((f) => f.properties['product-type'].replace(/^oblique-/, ''))
    .filter(isDirection)
    .toSorted((a, b) => DIRECTION_ORDER[a] - DIRECTION_ORDER[b])
  return { collection: newest.collection, directions: [...new Set(directions)] }
}

function limiter(max: number) {
  let active = 0
  const waiting: (() => void)[] = []
  return async <T>(task: () => Promise<T>) => {
    while (active >= max) await new Promise<void>((resolve) => waiting.push(resolve))
    active++
    try {
      return await task()
    } finally {
      active--
      waiting.shift()?.()
    }
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// The Vexcel imagery the routes serve. Every upstream answer goes through the disk cache, and the
// key travels only in the X-API-KEY header. Methods return a 404 entry when Vexcel has nothing and
// throw UpstreamError when it fails.
export function createVexcel({ apiKey, cache, fetch = globalThis.fetch }: { apiKey: string; cache: DiskCache; fetch?: typeof globalThis.fetch }) {
  const limit = limiter(MAX_CONCURRENT)

  // One upstream request, with the body read only on a 2xx. A network error, a redirect or a timeout,
  // including a body that stalls, becomes UpstreamError(502).
  async function attempt({ path, query, json }: UpstreamRequest) {
    const method = json ? 'POST' : 'GET'
    const started = performance.now()
    const done = (outcome: number | string) =>
      console.log(`vexcel ${method} ${path} ${outcome} ${Math.round(performance.now() - started)}ms`)
    try {
      const res = await fetch(`${BASE}/${path}${query ? `?${new URLSearchParams(query)}` : ''}`, {
        method,
        headers: { 'X-API-KEY': apiKey, ...(json && { 'Content-Type': 'application/json' }) },
        body: json && JSON.stringify(json),
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!res.ok) {
        await res.body?.cancel()
        done(res.status)
        return { ok: false as const, status: res.status }
      }
      const body = new Uint8Array(await res.arrayBuffer())
      done(res.status)
      return { ok: true as const, contentType: res.headers.get('content-type') ?? 'application/octet-stream', body }
    } catch {
      done('failed')
      throw new UpstreamError(502)
    }
  }

  const call = (request: UpstreamRequest) =>
    limit(async (): Promise<Cached> => {
      for (let retry = 0; ; retry++) {
        const res = await attempt(request)
        if (res.ok) return { status: 200, contentType: res.contentType, body: res.body }
        if (res.status === 429 && retry < BACKOFF_MS.length) {
          await sleep(BACKOFF_MS[retry])
          continue
        }
        if (res.status === 404) return { status: 404 }
        throw new UpstreamError(res.status)
      }
    })

  // A 200 that is not an image is an upstream error in disguise, so it is neither cached nor served.
  const image = (key: string, request: UpstreamRequest) =>
    cache.get(key, async () => {
      const answer = await call(request)
      if (answer.status === 200 && !answer.contentType.startsWith('image/')) throw new UpstreamError(502)
      return answer
    })

  // Parses before storing, so a body that is not JSON or has an unexpected shape is never cached.
  // Returns null on a 404.
  async function json<T>(key: string, request: UpstreamRequest, schema: z.ZodType<T>) {
    const parse = (body: Uint8Array) => {
      const result = schema.safeParse(parseJson(new TextDecoder().decode(body)))
      if (!result.success) {
        console.log(`vexcel ${request.path} answered an unexpected shape`)
        throw new UpstreamError(502)
      }
      return result.data
    }
    const answer = await cache.get(key, async () => {
      const fresh = await call(request)
      if (fresh.status === 200) parse(fresh.body)
      return fresh
    })
    return answer.status === 200 ? parse(answer.body) : null
  }

  // Parsed once per property and kept for the life of the process. A failed lookup is forgotten so
  // the next request retries it.
  const outlines = new Map<string, Promise<Outline>>()
  function outline(property: Property) {
    let pending = outlines.get(property.id)
    if (!pending) {
      pending = json(
        `parcel/${property.id}`,
        {
          path: 'property/extract',
          query: { wkt: `POINT(${property.lon} ${property.lat})`, srid: '4326', layer: LAYERS, latest: 'true', include: 'precomputed' },
        },
        ParcelResponse,
      ).then((parcel) => newestOutline(parcel, property))
      pending.catch(() => outlines.delete(property.id))
      outlines.set(property.id, pending)
    }
    return pending
  }

  // Asks with the parcel's bounds, not its outline, to keep the query string short.
  async function obliqueCoverage(property: Property) {
    const collections = await json(
      `oblique-coverage/${property.id}-bounds`,
      {
        path: 'oriented/collections',
        query: {
          wkt: boundsWkt((await outline(property)).bounds),
          srid: '4326',
          layer: 'urban',
          'product-type': 'oblique',
          include: 'product-type,collection,last-capture-date',
        },
      },
      CollectionsResponse,
    )
    return collections && newestObliques(collections)
  }

  return {
    tile: (z: number, x: number, y: number) =>
      image(`tiles/urban/${z}/${x}/${y}`, {
        path: 'ortho/wmts',
        query: {
          service: 'wmts',
          request: 'getTile',
          layer: 'urban',
          Style: 'RGB',
          TileMatrixSet: 'urban',
          TileMatrix: String(z),
          TileRow: String(y),
          TileCol: String(x),
          format: 'image/jpeg',
        },
      }),

    thumb: async (property: Property) =>
      image(`thumb/${property.id}-square-256`, {
        path: 'ortho/extract',
        json: {
          wkt: boundsWkt(squareBounds((await outline(property)).bounds)),
          srid: 4326,
          layer: LAYERS,
          'buffer-meter': 10,
          crop: 'bounding_box',
          'image-format': 'jpeg',
          'destination-dimensions': '256,256',
        },
      }),

    obliqueIndex: async (property: Property): Promise<ObliqueIndex> => ({
      directions: (await obliqueCoverage(property))?.directions ?? [],
    }),

    // Full resolution: about 1,900 px and 0.7-1 MB. Vexcel takes the same 1-2 s at downsample=2
    // (476 px), so the smaller frame saves no time and looks soft in a large photo panel.
    oblique: async (property: Property, direction: Direction): Promise<Cached> => {
      const coverage = await obliqueCoverage(property)
      if (!coverage?.directions.includes(direction)) return { status: 404 }
      return image(`oblique/${property.id}/${coverage.collection}/${direction}`, {
        path: 'oriented/extract',
        json: {
          wkt: (await outline(property)).wkt,
          srid: 4326,
          layer: 'urban',
          'product-type': `oblique-${direction}`,
          collection: coverage.collection,
          rotation: 'natural',
          'buffer-meter': 10,
          crop: 'bbox',
          'image-format': 'jpeg',
        },
      })
    },
  }
}

export type Vexcel = ReturnType<typeof createVexcel>

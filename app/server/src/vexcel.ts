import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Direction, LngLat, ObliqueIndex, ObliquePose } from '../../shared/api.ts'
import type { Property } from '../../shared/property.ts'
import type { Cached, DiskCache } from './cache.ts'
import { readObliquePose } from './obliquePose.ts'

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

// A background request waits behind every other one: map tiles and sidebar thumbnails, which no one
// waits on the way they wait on a property's photo.
type UpstreamRequest = { path: string; query?: Record<string, string>; json?: Record<string, unknown>; background?: true }

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

// What `extract` asks Vexcel to fill: `precomputed` detections such as pools and roof defects, and
// `calculated` measurements such as roof height and elevation.
export type ExtractInclude = 'precomputed' | 'calculated'

type Attribute = string | number | boolean

// One structure in one capture. `ring` is the footprint's outer ring as closed [lon, lat] points,
// the largest part's when Vexcel drew it as several. `id` hashes the footprint, so the same
// footprint in two answers has the same id. A parcel Vexcel gave no capture date is left out. `attributes` holds every filled value of the structure
// and of its parcel, keyed as Vexcel names them, such as `roof-characteristics.height`.
export type ExtractFeature = { id: string; ring: LngLat[]; capturedAt: string; primary: boolean; attributes: Record<string, Attribute> }

const ExtractResponse = z.object({
  features: z.array(
    z.object({
      properties: z.looseObject({
        'metadata.ortho-date-estimate': z.string().nullish(),
        structures: z
          .array(z.looseObject({ 'footprint.wkt': z.string().regex(/^\s*(MULTI)?POLYGON\s*\(/), 'primary-structure': z.boolean().nullish() }))
          .nullish(),
      }),
    }),
  ),
})

const DetectResponse = z.object({
  features: z.array(
    z.object({
      properties: z.object({ label: z.string(), detections: z.array(z.object({ bbox: z.string(), confidence: z.number() })) }),
    }),
  ),
})

// One object `detect` found: its label, the model's confidence and its box as a WKT polygon.
export type Detection = { label: string; confidence: number; bboxWkt: string }

const attributesOf = (record: Record<string, unknown>) =>
  Object.entries(record).filter(
    (entry): entry is [string, Attribute] =>
      ['string', 'number', 'boolean'].includes(typeof entry[1]) &&
      !entry[0].endsWith('.wkt') &&
      !/^(metadata|request-information)\./.test(entry[0]) &&
      entry[0] !== 'primary-structure',
  )

function largestOuterRing(wkt: string): LngLat[] {
  const rings = [...wkt.matchAll(/\(\(\s*([^()]+)\)/g)].map(([, list]) =>
    list.split(',').map((pair): LngLat => {
      const [lon, lat] = pair.trim().split(/\s+/).map(Number)
      return [lon, lat]
    }),
  )
  const area = (ring: LngLat[]) =>
    Math.abs(ring.slice(1).reduce((sum, [x, y], i) => sum + ring[i][0] * y - x * ring[i][1], 0))
  return rings.reduce((best, ring) => (area(ring) > area(best) ? ring : best), [])
}

function extractFeatures({ features }: z.infer<typeof ExtractResponse>): ExtractFeature[] {
  return features.flatMap(({ properties }) => {
    const capturedAt = properties['metadata.ortho-date-estimate']
    if (!capturedAt) return []
    const parcel = attributesOf(properties)
    return (properties.structures ?? []).map((structure) => ({
      id: createHash('sha256').update(structure['footprint.wkt']).digest('hex').slice(0, 16),
      ring: largestOuterRing(structure['footprint.wkt']),
      capturedAt,
      primary: structure['primary-structure'] === true,
      attributes: Object.fromEntries([...parcel, ...attributesOf(structure)]),
    }))
  })
}

// A coordinate as a cache key segment. cacheFile rejects a segment that starts with a minus sign.
const keyCoordinate = (degrees: number) => degrees.toFixed(7).replace('-', 'm')

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

// The client frames the property's bounds grown by FOCUS_MARGIN at rest, centred on the pin, and the
// photo is a ground square reaching REACH from the pin, so at rest the photo covers the whole map and
// no edge of it shows against the tiles it does not line up with. Vexcel's time grows with the
// ground it reads, not the pixels it returns, so REACH is what a first click can wait for at full
// resolution, since `downsample` is slower and visibly soft. The square needs
// only the pin, so the extract starts without waiting for the parcel. A parcel too big for it is
// framed tighter by the client's cover fit.
const FOCUS_MARGIN = 10
const REACH = 80

export function obliqueFocus(b: Bounds): LngLat[] {
  const lonScale = M_PER_DEG_LAT * Math.cos((((b.south + b.north) / 2) * Math.PI) / 180)
  const [dLon, dLat] = [FOCUS_MARGIN / lonScale, FOCUS_MARGIN / M_PER_DEG_LAT]
  const [west, south, east, north] = [b.west - dLon, b.south - dLat, b.east + dLon, b.north + dLat]
  return [[west, north], [east, north], [east, south], [west, south]]
}

// The bounds of a property's newest parcel. `property/extract` returns one feature per capture,
// unsorted even with `latest=true`. A point with no parcel gets a 100 m square around it.
export function newestBounds(parcel: z.infer<typeof ParcelResponse> | null, { lon, lat }: Property) {
  const newest = parcel?.features.toSorted((a, b) =>
    (b.properties['metadata.ortho-date-estimate'] ?? '').localeCompare(a.properties['metadata.ortho-date-estimate'] ?? ''),
  )[0]
  return newest ? boundsOf(newest.geometry) : squareAround(lon, lat, 50)
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

// At most `max` tasks at once. Urgent tasks wait ahead of all others, so the one photo a
// user is waiting for does not queue behind the dozens of map tiles a camera flight asks for.
// Within each queue the newest waiter goes first: the property just clicked beats the ones the
// cursor passed over, and the tiles in view beat the ones a flight has already left behind. A
// finished task hands its slot straight to the next waiter, so nothing can take it in between.
export function limiter(max: number) {
  let active = 0
  const urgentQueue: (() => void)[] = []
  const queue: (() => void)[] = []
  return async <T>(task: () => Promise<T>, urgent: boolean) => {
    if (active >= max) await new Promise<void>((resolve) => (urgent ? urgentQueue : queue).push(resolve))
    else active++
    try {
      return await task()
    } finally {
      const next = urgentQueue.pop() ?? queue.pop()
      if (next) next()
      else active--
    }
  }
}

// The parsed JSON, or undefined when `text` is not JSON.
export function parseJson(text: string): unknown {
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
    }, !request.background)

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
  const parcels = new Map<string, Promise<Bounds>>()
  function parcelBounds(property: Property) {
    let pending = parcels.get(property.id)
    if (!pending) {
      pending = json(
        `parcel/${property.id}`,
        {
          path: 'property/extract',
          query: { wkt: `POINT(${property.lon} ${property.lat})`, srid: '4326', layer: LAYERS, latest: 'true', include: 'precomputed' },
        },
        ParcelResponse,
      ).then((parcel) => newestBounds(parcel, property))
      pending.catch(() => parcels.delete(property.id))
      parcels.set(property.id, pending)
    }
    return pending
  }

  // Asks about a small square around the pin, so the lookup need not wait for the parcel.
  async function obliqueCoverage(property: Property) {
    const collections = await json(
      `oblique-coverage/${property.id}-point`,
      {
        path: 'oriented/collections',
        query: {
          wkt: boundsWkt(squareAround(property.lon, property.lat, 50)),
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
        background: true,
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
        background: true,
        json: {
          wkt: boundsWkt(squareBounds(await parcelBounds(property))),
          srid: 4326,
          layer: LAYERS,
          'buffer-meter': 10,
          crop: 'bounding_box',
          'image-format': 'jpeg',
          'destination-dimensions': '256,256',
        },
      }),

    // Every structure Vexcel has at a point, one entry per structure per capture. Captures come
    // unsorted even with `latest=true`, so pick one by `capturedAt`. `bufferM` widens the point to a
    // circle, which brings in the neighbours' structures. A point with nothing returns []. A
    // non-finite point or a negative buffer throws RangeError.
    //   const own = await vexcel.extract(lat, lon, { include: ['calculated'] })
    extract: async (
      lat: number,
      lon: number,
      { bufferM = 0, include }: { bufferM?: number; include: readonly [ExtractInclude, ...ExtractInclude[]] },
    ): Promise<ExtractFeature[]> => {
      if (![lat, lon, bufferM].every(Number.isFinite) || bufferM < 0) {
        throw new RangeError('extract needs a finite point and a buffer of 0 m or more')
      }
      const includes = [...new Set(include)].toSorted()
      const answer = await json(
        `extract/${keyCoordinate(lat)}_${keyCoordinate(lon)}-b${bufferM}-${includes.join('.')}`,
        {
          path: 'property/extract',
          query: {
            wkt: `POINT(${lon} ${lat})`,
            srid: '4326',
            layer: LAYERS,
            latest: 'true',
            include: includes.join(','),
            ...(bufferM > 0 && { 'buffer-meter': String(bufferM) }),
          },
        },
        ExtractResponse,
      )
      return answer ? extractFeatures(answer) : []
    },

    // Every object matching one of `labels` that Vexcel's open-vocabulary model finds on the ortho
    // of a ground square reaching `halfM` from the point. It runs live, so a call takes seconds the
    // first time; answers are cached by request. Keep the square small: Vexcel downsamples a large
    // area without saying so.
    //   const cars = await vexcel.detect(lat, lon, { labels: ['car'], halfM: 40, threshold: 0.5 })
    detect: async (
      lat: number,
      lon: number,
      { labels, halfM, threshold }: { labels: readonly string[]; halfM: number; threshold: number },
    ): Promise<Detection[]> => {
      const wkt = boundsWkt(squareAround(lon, lat, halfM))
      const body = {
        wkt,
        srid: 4326,
        'buffer-meter': 0,
        images: [{ endpoint: 'ortho/extract', request: { layer: LAYERS, srid: 4326, wkt, crop: 'bounding_box' } }],
        'model-input': {
          elements: labels.map((label) => ({ label, model: 'sam3', 'detection-threshold': threshold })),
          include: ['bbox', 'confidence'],
        },
      }
      const key = createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 32)
      const answer = await json(`detect/${key}`, { path: 'elements/detect', json: body }, DetectResponse)
      return (answer?.features ?? []).flatMap(({ properties: { label, detections } }) =>
        detections.map(({ bbox, confidence }) => ({ label, confidence, bboxWkt: bbox })),
      )
    },

    obliqueIndex: async (property: Property): Promise<ObliqueIndex> => ({
      directions: (await obliqueCoverage(property))?.directions ?? [],
    }),

    // One angled photo of the ground square REACH around the pin, with its pose, or a null pose when
    // its XMP is unreadable. The parcel lookup runs alongside, since only the pose needs it, and a
    // failed lookup frames the pin as a point with no parcel would, so the photo still shows. The key
    // names the reach, so photos cut to another extent are fetched again and the old ones age out.
    oblique: async (property: Property, direction: Direction): Promise<{ photo: Cached; pose: ObliquePose | null }> => {
      const pin: LngLat = [property.lon, property.lat]
      const bounds = parcelBounds(property)
      const coverage = await obliqueCoverage(property)
      if (!coverage?.directions.includes(direction)) return { photo: { status: 404 }, pose: null }
      const photo = await image(`oblique/${property.id}/${coverage.collection}/${direction}-r${REACH}`, {
        path: 'oriented/extract',
        json: {
          wkt: boundsWkt(squareAround(...pin, REACH)),
          srid: 4326,
          layer: 'urban',
          'product-type': `oblique-${direction}`,
          collection: coverage.collection,
          rotation: 'natural',
          crop: 'bbox',
          'image-format': 'jpeg',
        },
      })
      if (photo.status !== 200) return { photo, pose: null }
      return { photo, pose: readObliquePose(photo.body, obliqueFocus(await bounds.catch(() => newestBounds(null, property))), pin) }
    },
  }
}

export type Vexcel = ReturnType<typeof createVexcel>

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { LngLat } from '../../shared/api.ts'
import type { Property } from '../../shared/property.ts'
import { createApp, parseTile } from './app.ts'
import { type Cached, cacheFile, createDiskCache } from './cache.ts'
import { readObliquePose } from './obliquePose.ts'
import { createVexcel, limiter, newestObliques, obliqueFocus, squareBounds } from './vexcel.ts'

const roots: string[] = []
after(() => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))))
async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), 'propstar-cache-'))
  roots.push(root)
  return root
}

const jpeg = (bytes: number[]): Cached => ({ status: 200, contentType: 'image/jpeg', body: new Uint8Array(bytes) })

test('concurrent gets for one key share one fetch, and a new cache over the same folder reads it from disk', async () => {
  const root = await tempRoot()
  let fetches = 0
  const fetch = async () => {
    fetches++
    await new Promise((resolve) => setTimeout(resolve, 10))
    return jpeg([1, 2, 3])
  }
  const cache = createDiskCache(root)
  const answers = await Promise.all([cache.get('tiles/urban/1/0/0', fetch), cache.get('tiles/urban/1/0/0', fetch)])
  assert.equal(fetches, 1)
  assert.deepEqual(answers[0], answers[1])

  const reread = await createDiskCache(root).get('tiles/urban/1/0/0', fetch)
  assert.equal(fetches, 1)
  assert.equal(reread.status, 200)
  assert.equal(reread.status === 200 && reread.contentType, 'image/jpeg')
  assert.deepEqual(reread.status === 200 && [...reread.body], [1, 2, 3])
})

test('a 404 is cached but a failed fetch is not', async () => {
  const cache = createDiskCache(await tempRoot())
  let fetches = 0
  const missing = async (): Promise<Cached> => (fetches++, { status: 404 })
  await cache.get('tiles/urban/22/0/0', missing)
  assert.deepEqual(await cache.get('tiles/urban/22/0/0', missing), { status: 404 })
  assert.equal(fetches, 1)

  await assert.rejects(cache.get('thumb/x', async () => Promise.reject(new Error('503'))))
  assert.deepEqual(await cache.get('thumb/x', async () => jpeg([9])), jpeg([9]))
})

test('a corrupt meta file is a miss, not a crash', async () => {
  const root = await tempRoot()
  const cache = createDiskCache(root)
  await cache.get('thumb/a', async () => jpeg([1]))
  await writeFile(join(root, 'thumb/a.meta'), '{"status":200}')
  assert.deepEqual(await cache.get('thumb/a', async () => jpeg([2])), jpeg([2]))
  await writeFile(join(root, 'thumb/a.meta'), 'not json')
  assert.deepEqual(await createDiskCache(root).get('thumb/a', async () => jpeg([3])), jpeg([3]))
})

test('cache keys cannot leave the cache folder', () => {
  assert.equal(cacheFile('/c', 'oblique/commercial-1/us-ca-2025/north'), join('/c', 'oblique/commercial-1/us-ca-2025/north'))
  for (const key of ['../.env', 'tiles/../../x', '/etc/passwd', 'a//b', '.env']) assert.throws(() => cacheFile('/c', key), key)
})

test('tile params must be integers inside the zoom grid', () => {
  assert.deepEqual(parseTile('19', '89726', '209379'), { z: 19, x: 89726, y: 209379 })
  assert.deepEqual(parseTile('0', '0', '0'), { z: 0, x: 0, y: 0 })
  for (const [z, x, y] of [['22', '0', '0'], ['-1', '0', '0'], ['1.5', '0', '0'], ['1', '2', '0'], ['abc', '0', '0'], ['3', '0', '1e3']]) {
    assert.equal(parseTile(z, x, y), null, `${z}/${x}/${y}`)
  }
})

test('only the newest oblique collection counts, in north-east-south-west order', () => {
  const feature = (collection: string, date: string, type: string) => ({
    properties: { collection, 'last-capture-date': date, 'product-type': type },
  })
  const index = newestObliques({
    features: [
      feature('la-2024', '2024-04-16T20:11:35', 'oblique-south'),
      feature('la-2025', '2025-12-10T21:03:34', 'oblique-west'),
      feature('la-2025', '2025-12-10T21:03:34', 'oblique-north'),
      feature('la-2025', '2025-12-10T21:03:34', 'oblique-east'),
    ],
  })
  assert.deepEqual(index, { collection: 'la-2025', directions: ['north', 'east', 'west'] })
  assert.equal(newestObliques({ features: [] }), null)
})

test('a thumb box is square on the ground around the parcel', () => {
  const box = squareBounds({ west: -118.001, south: 34, east: -118, north: 34.002 })
  const lat = 34.001
  const width = (box.east - box.west) * Math.cos((lat * Math.PI) / 180)
  assert.ok(Math.abs(width - (box.north - box.south)) < 1e-9)
  assert.ok(Math.abs(box.north - box.south - 0.002) < 1e-12)
  assert.ok(Math.abs((box.west + box.east) / 2 + 118.0005) < 1e-12)
})

const property: Property = {
  id: 'commercial-1', kind: 'commercial', costarId: '1', name: 'A', address: 'A', lat: 34, lon: -118,
  typeLabel: 'Office', facts: [], photoUrl: null, scans: [],
}

test('only requests for this machine from the same site get through', async () => {
  const app = createApp({ properties: [property], vexcel: createVexcel({ apiKey: 'k', cache: createDiskCache(await tempRoot()) }) })
  const status = async (url: string, headers: Record<string, string> = {}) => (await app.request(url, { headers })).status
  // What the Vite proxy forwards for a same-origin fetch from the app.
  assert.equal(await status('http://localhost:5173/api/properties', { 'sec-fetch-site': 'same-origin' }), 200)
  assert.equal(await status('http://127.0.0.1:8787/api/properties'), 200)
  assert.equal(await status('http://rebound.example:8787/api/properties'), 403)
  assert.equal(await status('http://localhost.example/api/properties'), 403)
  assert.equal(await status('http://localhost:5173/api/properties', { 'sec-fetch-site': 'cross-site' }), 403)
})

test('a 200 that is not JSON is a 502, and nothing is cached', async () => {
  let calls = 0
  const fetch: typeof globalThis.fetch = async () => (calls++, new Response('<html>maintenance</html>', { status: 200 }))
  const app = createApp({ properties: [property], vexcel: createVexcel({ apiKey: 'k', cache: createDiskCache(await tempRoot()), fetch }) })
  for (let i = 0; i < 2; i++) {
    const res = await app.request('/api/oblique/commercial-1')
    assert.equal(res.status, 502)
    assert.deepEqual(await res.json(), { error: 'Vexcel failed' })
  }
  assert.equal(calls, 2)
})

test('routes reject bad input without calling Vexcel and serve repeat misses from the cache', async () => {
  const calls: string[] = []
  const fetch: typeof globalThis.fetch = async (input) => {
    calls.push(String(input))
    return new Response('{"status":404}', { status: 404, headers: { 'content-type': 'application/json' } })
  }
  const app = createApp({
    properties: [property],
    vexcel: createVexcel({ apiKey: 'test-key', cache: createDiskCache(await tempRoot()), fetch }),
  })

  for (const path of ['/api/thumb/commercial-2', '/api/oblique/commercial-2', '/api/oblique/commercial-2/north']) {
    const res = await app.request(path)
    assert.equal(res.status, 404, path)
    assert.deepEqual(await res.json(), { error: 'Unknown property' })
  }
  assert.equal((await app.request('/api/tiles/22/0/0')).status, 400)
  assert.equal((await app.request('/api/oblique/commercial-1/up')).status, 400)
  for (const path of ['/.env', '/api/../.env', '/', '/api/nope']) {
    const res = await app.request(path)
    assert.equal(res.status, 404, path)
    assert.equal(await res.text(), '', path)
  }
  assert.equal(calls.length, 0)

  for (let i = 0; i < 2; i++) {
    const res = await app.request('/api/tiles/21/0/0')
    assert.equal(res.status, 404)
    assert.equal(res.headers.get('cache-control'), 'private, max-age=86400')
    assert.deepEqual(await res.json(), { error: 'No imagery here' })
  }
  assert.equal(calls.length, 1)
})

test('a budgeted prefix evicts its least recently used entries, and the order survives a restart', async () => {
  const root = await tempRoot()
  const body = (n: number) => async () => jpeg(Array(100).fill(n))
  const stored = async (key: string) => readFile(join(root, `${key}.body`)).then(() => true, () => false)
  const cache = createDiskCache(root, { oblique: 300 })
  await cache.get('oblique/a', body(1))
  await cache.get('oblique/b', body(2))
  await cache.get('oblique/a', body(9))
  await cache.get('oblique/c', body(3))
  await cache.get('tiles/x', body(4))
  assert.deepEqual(await Promise.all(['oblique/a', 'oblique/b', 'oblique/c', 'tiles/x'].map(stored)), [true, false, true, true])
  const { oblique } = await cache.usage()
  assert.equal(oblique.entries, 2)
  assert.ok(oblique.bytes <= 300)

  const [old, recent] = [new Date(Date.now() - 60_000), new Date()]
  // The reverse of both write order and file name order, so only the meta mtimes can give it.
  await utimes(join(root, 'oblique/c.meta'), old, old)
  await utimes(join(root, 'oblique/a.meta'), recent, recent)
  await createDiskCache(root, { oblique: 300 }).get('oblique/d', body(5))
  assert.deepEqual(await Promise.all(['oblique/a', 'oblique/c', 'oblique/d'].map(stored)), [true, false, true])
})

// A JPEG stand-in carrying only the XMP fields the pose reader uses: a 1000 px square frame looking
// straight down at a 100 m square, north up.
function fakeOblique(crop = '250,250,500,500') {
  const [lon, lat, dLon, dLat] = [-118, 34, 100 / (111_320 * Math.cos(((34 + 100 / 111_320) * Math.PI) / 180)), 100 / 111_320]
  const tags = {
    'capture-date': '2025-12-01 19:55:59.0',
    'raster-size-width': '1000',
    'raster-size-height': '1000',
    'pixel-bbox': crop,
    geometry: `POLYGON ((${lon} ${lat + dLat}, ${lon + dLon} ${lat + dLat}, ${lon + dLon} ${lat}, ${lon} ${lat}, ${lon} ${lat + dLat}))`,
  }
  const xmp = Object.entries(tags).map(([k, v]) => `<Vexcel:${k}>${v}</Vexcel:${k}>`).join('')
  return new Uint8Array([0xff, 0xd8, ...new TextEncoder().encode(xmp)])
}

// A box `half` metres either side of a point, corners in pose order.
function boxAround([lon, lat]: LngLat, half: number): LngLat[] {
  const [dLon, dLat] = [half / (111_320 * Math.cos((lat * Math.PI) / 180)), half / 111_320]
  return [[lon - dLon, lat + dLat], [lon + dLon, lat + dLat], [lon + dLon, lat - dLat], [lon - dLon, lat - dLat]]
}

// A 20 m box centred on the fake photo's ground, so 200 px of a 1000 px frame and centred in the crop.
const fakeLonScale = 111_320 * Math.cos(((34 + 50 / 111_320) * Math.PI) / 180)
const fakeCentre: LngLat = [-118 + 50 / fakeLonScale, 34 + 50 / 111_320]
const fakeFocus = boxAround(fakeCentre, 10)

test('the pose of a photo comes from its frame footprint and crop', () => {
  const pose = readObliquePose(fakeOblique(), fakeFocus, fakeCentre)
  assert.ok(pose)
  assert.equal(pose.width, 500)
  assert.equal(pose.capturedOn, '2025-12-01')
  assert.ok(Math.abs(pose.bearing) < 1e-6 && Math.abs(pose.pitch) < 1e-3, `${pose.bearing} ${pose.pitch}`)
  assert.ok(Math.abs(pose.metresPerPixel - 0.1) < 1e-6)
  const { x, y, width, height } = pose.focus
  assert.ok([x - 150, y - 150, width - 200, height - 200].every((d) => Math.abs(d) < 0.5), JSON.stringify(pose.focus))
  const [tl, , br] = pose.quad
  assert.ok(Math.abs((tl[1] + br[1]) / 2 - (34 + 50 / 111_320)) < 1e-9)
  assert.ok(tl[1] > br[1] && tl[0] < br[0])
  assert.equal(readObliquePose(fakeOblique('250,250'), fakeFocus, fakeCentre), null)
  assert.equal(readObliquePose(new Uint8Array([0xff, 0xd8]), fakeFocus, fakeCentre), null)
})

test('the focus box grows evenly around a pin off the middle of the property', () => {
  const pin: LngLat = [fakeCentre[0] + 5 / fakeLonScale, fakeCentre[1]]
  const pose = readObliquePose(fakeOblique(), fakeFocus, pin)
  assert.ok(pose)
  const { center, x, y, width, height } = pose.focus
  assert.ok([x - 150, y - 150, width - 300, height - 200].every((d) => Math.abs(d) < 0.5), JSON.stringify(pose.focus))
  assert.ok(Math.abs(center[0] - pin[0]) < 1e-9 && Math.abs(center[1] - pin[1]) < 1e-9)
  const off = readObliquePose(fakeOblique(), fakeFocus, [0, 0])?.focus
  assert.ok(off && Math.abs(off.x - 150) < 0.5 && Math.abs(off.width - 200) < 0.5, 'a pin off the photo leaves the box on the property')
})

test('an oblique photo is a 160 m square around the pin, cut before the parcel is known', { timeout: 2000 }, async () => {
  let releaseParcel = () => {}
  const parcelGate = new Promise<void>((resolve) => (releaseParcel = resolve))
  const asked: Record<string, string> = {}
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('property/extract')) {
      await parcelGate
      return new Response(null, { status: 404 })
    }
    if (url.pathname.endsWith('oriented/collections')) {
      asked.collections = url.searchParams.get('wkt') ?? ''
      const properties = { collection: 'la-2025', 'last-capture-date': '2025-12-10T21:03:34', 'product-type': 'oblique-north' }
      return Response.json({ features: [{ properties }] })
    }
    asked.extract = JSON.parse(String(init?.body)).wkt
    releaseParcel()
    return new Response(fakeOblique(), { headers: { 'content-type': 'image/jpeg' } })
  }
  const app = createApp({ properties: [property], vexcel: createVexcel({ apiKey: 'k', cache: createDiskCache(await tempRoot()), fetch }) })
  assert.equal((await app.request('/api/oblique/commercial-1/north')).status, 200)
  const corners = (wkt = '') => [...wkt.matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])])
  const xs = corners(asked.extract).map((c) => c[0])
  const ys = corners(asked.extract).map((c) => c[1])
  const metres = (deg: number[], scale: number) => (Math.max(...deg) - Math.min(...deg)) * scale
  assert.ok(Math.abs(metres(ys, 111_320) - 160) < 1e-6 && Math.abs(metres(xs, 111_320 * Math.cos((34 * Math.PI) / 180)) - 160) < 1e-6)
  assert.ok(Math.abs((Math.max(...xs) + Math.min(...xs)) / 2 - property.lon) < 1e-9 && Math.abs((Math.max(...ys) + Math.min(...ys)) / 2 - property.lat) < 1e-9)
  assert.ok(asked.collections.startsWith('POLYGON'))
})

test('the client frames the parcel with 10 m to spare', () => {
  const lat = 34.03
  const parcel = { west: -118.25, south: lat, east: -118.2493, north: lat + 72 / 111_320 }
  const [nw, , se] = obliqueFocus(parcel)
  assert.ok(Math.abs(nw[1] - parcel.north - 10 / 111_320) < 1e-12)
  assert.ok(Math.abs(se[0] - parcel.east - 10 / (111_320 * Math.cos(((lat + 36 / 111_320) * Math.PI) / 180))) < 1e-9)
})

const MEASURED = new URL('../../../data/propstar/cache/vexcel/oblique/commercial-1254240/us-ca-losangeles-2025/', import.meta.url)
const measured = await readFile(new URL('north.body', MEASURED)).then(() => true, () => false)

test('poses match the ones measured on cached Los Angeles photos', { skip: !measured && 'no cached photos' }, async () => {
  const expected = { north: [1228, 1034, 0.308, 40.797], east: [1301, 926, 89.311, 45.171], south: [1244, 1124, -177.985, 41.504] }
  for (const [direction, [width, height, bearing, pitch]] of Object.entries(expected)) {
    const body = await readFile(new URL(`${direction}.body`, MEASURED))
    // Framing the photo's own footprint, with no pin on it, measures the camera at the crop's centre.
    const pin: LngLat = [-118.2499818, 34.0341946]
    const quad = readObliquePose(body, boxAround(pin, 10), pin)?.quad ?? []
    const pose = readObliquePose(body, quad, [0, 0])
    assert.ok(pose, direction)
    assert.deepEqual([pose.width, pose.height], [width, height], direction)
    assert.ok(Math.abs(pose.bearing - bearing) < 1e-3 && Math.abs(pose.pitch - pitch) < 1e-3, `${direction} ${pose.bearing} ${pose.pitch}`)
  }
})

test('an oblique photo carries its pose in a header', async () => {
  const fetch: typeof globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname
    if (path.endsWith('property/extract')) return new Response(null, { status: 404 })
    if (path.endsWith('oriented/collections')) {
      const properties = { collection: 'la-2025', 'last-capture-date': '2025-12-10T21:03:34', 'product-type': 'oblique-east' }
      return Response.json({ features: [{ properties }] })
    }
    return new Response(fakeOblique(), { headers: { 'content-type': 'image/jpeg' } })
  }
  const app = createApp({ properties: [property], vexcel: createVexcel({ apiKey: 'k', cache: createDiskCache(await tempRoot()), fetch }) })
  assert.deepEqual(await (await app.request('/api/oblique/commercial-1')).json(), { directions: ['east'] })
  assert.equal((await app.request('/api/oblique/commercial-1/north')).status, 404)
  const res = await app.request('/api/oblique/commercial-1/east')
  assert.equal(res.status, 200)
  assert.equal(JSON.parse(res.headers.get('x-oblique-pose') ?? 'null')?.width, 500)
})

test('the limiter serves urgent waiters first, newest first, and a freed slot goes to a waiter', async () => {
  const limit = limiter(1)
  const order: string[] = []
  let release = () => {}
  const first = limit(() => new Promise<void>((resolve) => (release = resolve)), false)
  const queued = [['tile-old', false], ['tile-new', false], ['hover', true], ['click', true]] as const
  const waiting = queued.map(([name, urgent]) => limit(async () => void order.push(name), urgent))
  release()
  await first
  // Arrives after the slot was freed but before its waiter ran, so it must not take the slot.
  const late = limit(async () => void order.push('late'), true)
  await Promise.all([...waiting, late])
  assert.deepEqual(order, ['click', 'late', 'hover', 'tile-new', 'tile-old'])
})

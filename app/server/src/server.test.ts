import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { Property } from '../../shared/property.ts'
import { createApp, parseTile } from './app.ts'
import { type Cached, cacheFile, createDiskCache } from './cache.ts'
import { createVexcel, newestObliques, squareBounds } from './vexcel.ts'

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

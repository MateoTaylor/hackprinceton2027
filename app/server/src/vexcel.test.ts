import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { createDiskCache } from './cache.ts'
import { createVexcel } from './vexcel.ts'

const roots: string[] = []
after(() => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))))
async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), 'propstar-vexcel-'))
  roots.push(root)
  return root
}

// Three captures of one invented parcel, out of date order. The 2025 capture has a tower drawn as
// two parts and a shed, the 2023 capture has no structures, and one parcel has no date at all.
const ANSWER = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
      properties: {
        'metadata.ortho-date-estimate': '2021-03-01',
        'metadata.collection': 'old',
        structures: [{ 'footprint.wkt': 'POLYGON((-100 20,-99 20,-99 21,-100 20))', 'primary-structure': true }],
      },
    },
    {
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
      properties: {
        'metadata.ortho-date-estimate': '2025-06-01',
        'request-information.requested-wkt': 'POINT(-100.5 20.5)',
        'pool.detected': false,
        'parcel-tree-cover.percent': 12.5,
        'census-tract': null,
        structures: [
          {
            'footprint.wkt': 'MULTIPOLYGON(((-100 20,-99.9 20,-99.9 20.1,-100 20)),((-101 20,-100 20,-100 21,-101 21,-101 20)))',
            'primary-structure': true,
            'roof-characteristics.height': 40,
            'roof-characteristics.elevation': 52,
            'roof-characteristics.centroid.wkt': 'POINT(-100.5 20.5)',
            'roof-characteristics.eave-height': null,
            'building-type.class': 'office',
          },
          { 'footprint.wkt': 'POLYGON((-100 22,-99 22,-99 23,-100 22))', 'primary-structure': false, 'roof-characteristics.height': 2 },
        ],
      },
    },
    { type: 'Feature', geometry: null, properties: { 'metadata.ortho-date-estimate': '2023-01-01', structures: null } },
    { type: 'Feature', geometry: null, properties: { 'metadata.collection': 'old' } },
  ],
}

async function fakeVexcel(body: unknown, status = 200) {
  const urls: URL[] = []
  const fetch: typeof globalThis.fetch = async (input) => {
    urls.push(new URL(String(input)))
    return Response.json(body, { status })
  }
  return { urls, vexcel: createVexcel({ apiKey: 'k', cache: createDiskCache(await tempRoot()), fetch }) }
}

test('extract asks property/extract about the point, keeps every structure of every capture and reads a repeat from the cache', async () => {
  const { urls, vexcel } = await fakeVexcel(ANSWER)
  const features = await vexcel.extract(20.5, -100.5, { include: ['calculated', 'precomputed'] })

  assert.equal(urls.length, 1)
  const [url] = urls
  assert.ok(url.pathname.endsWith('/property/extract'))
  assert.equal(url.searchParams.get('wkt'), 'POINT(-100.5 20.5)')
  assert.equal(url.searchParams.get('srid'), '4326')
  assert.equal(url.searchParams.get('latest'), 'true')
  assert.equal(url.searchParams.get('include'), 'calculated,precomputed')
  assert.equal(url.searchParams.get('buffer-meter'), null)

  assert.deepEqual(
    features.map((f) => [f.capturedAt, f.primary]),
    [['2021-03-01', true], ['2025-06-01', true], ['2025-06-01', false]],
  )
  const tower = features[1]
  assert.deepEqual(tower.ring, [[-101, 20], [-100, 20], [-100, 21], [-101, 21], [-101, 20]])
  assert.deepEqual(tower.attributes, {
    'pool.detected': false,
    'parcel-tree-cover.percent': 12.5,
    'roof-characteristics.height': 40,
    'roof-characteristics.elevation': 52,
    'building-type.class': 'office',
  })
  assert.equal(new Set(features.map((f) => f.id)).size, 3)

  assert.deepEqual(await vexcel.extract(20.5, -100.5, { include: ['precomputed', 'calculated'] }), features)
  assert.equal(urls.length, 1)
})

test('extract sends the buffer, keys the cache by buffer and include, and gives the same footprint the same id', async () => {
  const { urls, vexcel } = await fakeVexcel(ANSWER)
  const own = await vexcel.extract(20.5, -100.5, { include: ['calculated'] })
  const around = await vexcel.extract(20.5, -100.5, { bufferM: 150, include: ['calculated'] })

  assert.equal(urls.length, 2)
  assert.equal(urls[1].searchParams.get('buffer-meter'), '150')
  assert.deepEqual(around.map((f) => f.id), own.map((f) => f.id))
})

test('a point with nothing returns an empty list once, and a bad point never reaches fetch', async () => {
  const { urls, vexcel } = await fakeVexcel({ status: 404 }, 404)
  assert.deepEqual(await vexcel.extract(20, -100, { include: ['calculated'] }), [])
  assert.deepEqual(await vexcel.extract(20, -100, { include: ['calculated'] }), [])
  assert.equal(urls.length, 1)

  await assert.rejects(vexcel.extract(Number.NaN, -100, { include: ['calculated'] }), RangeError)
  await assert.rejects(vexcel.extract(20, -100, { bufferM: -1, include: ['calculated'] }), RangeError)
  assert.equal(urls.length, 1)
})

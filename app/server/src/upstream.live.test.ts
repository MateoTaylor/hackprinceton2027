// Calls the real Vexcel and Matterport APIs once each and prints counts only. Each test skips unless
// its keys are in the environment. Run them from app/server with the keys loaded:
//   node --env-file=../../.env --test src/upstream.live.test.ts
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'
import { createDiskCache } from './cache.ts'
import { createMatterport } from './matterport.ts'
import { loadProperties } from './properties.ts'
import { createVexcel } from './vexcel.ts'

const PROPERTY = 'commercial-248243'
const MODEL = 'aYTUWzQVbUs'
const DB = fileURLToPath(new URL('../../../data/propstar/propstar.duckdb', import.meta.url))

const { VEXCEL_API_KEY, MP_TOKEN_ID, MP_TOKEN_SECRET } = process.env

const roots: string[] = []
after(() => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))))
async function freshCache() {
  const root = await mkdtemp(join(tmpdir(), 'propstar-live-'))
  roots.push(root)
  return createDiskCache(root)
}

test('extract returns the structures at the worked example', { skip: !VEXCEL_API_KEY && 'VEXCEL_API_KEY is not set' }, async () => {
  const property = (await loadProperties(DB)).find((p) => p.id === PROPERTY)
  assert.ok(property, `${PROPERTY} is not in the database`)
  const vexcel = createVexcel({ apiKey: VEXCEL_API_KEY ?? '', cache: await freshCache() })
  const features = await vexcel.extract(property.lat, property.lon, { include: ['precomputed', 'calculated'] })
  assert.ok(features.length > 0)
  assert.ok(features.every((f) => f.ring.length >= 4))
  console.log(`extract features: ${features.length}`)
})

test(
  'floorPlan returns the rooms of the worked example scan',
  { skip: !(MP_TOKEN_ID && MP_TOKEN_SECRET) && 'MP_TOKEN_ID or MP_TOKEN_SECRET is not set' },
  async () => {
    const matterport = createMatterport({ tokenId: MP_TOKEN_ID ?? '', tokenSecret: MP_TOKEN_SECRET ?? '', cache: await freshCache() })
    const plan = await matterport.floorPlan(MODEL)
    assert.ok(plan.rooms.length > 0)
    console.log(`floorPlan rooms: ${plan.rooms.length}`)
  },
)

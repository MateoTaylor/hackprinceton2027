import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { z } from 'zod'
import { createApp } from '../app.ts'
import { createDiskCache } from '../cache.ts'
import { createVexcel } from '../vexcel.ts'
import { createViewStore } from '../view/store.ts'
import { OPS, PROPPY_OPS } from './index.ts'
import { createViewOps } from './view/index.ts'

const ALL = [...OPS, ...createViewOps(createViewStore()), ...PROPPY_OPS]
const PRIVATE = ['area_places', 'area_roads', 'area_summary']

const PERSONAL = /broker|contact|email|phone/i

function schemaKeys(schema: unknown): string[] {
  if (Array.isArray(schema)) return schema.flatMap(schemaKeys)
  if (typeof schema !== 'object' || schema === null) return []
  return Object.entries(schema).flatMap(([key, value]) => [
    ...(key === 'properties' && typeof value === 'object' && value !== null ? Object.keys(value) : []),
    ...schemaKeys(value),
  ])
}

test('no two ops share a name', () => {
  assert.equal(new Set(ALL.map((op) => op.name)).size, ALL.length)
})

for (const op of ALL) {
  test(`${op.name} has a valid name, a short summary and schemas a model can read`, () => {
    assert.match(op.name, /^[a-z][a-z0-9_]{2,40}$/)
    assert.ok(op.summary.length > 0 && op.summary.length <= 160, `summary is ${op.summary.length} characters`)
    z.toJSONSchema(op.input, { io: 'input' })
    for (const schema of [op.output, op.detail]) {
      if (!schema) continue
      const personal = schemaKeys(z.toJSONSchema(schema)).filter((name) => PERSONAL.test(name))
      assert.deepEqual(personal, [], 'an output or detail field names a person')
    }
  })
}

test('Proppy-only ops are listed and run only under /api/proppy/ops', async () => {
  const unused = join(tmpdir(), 'propstar-guard-test-unused')
  const app = createApp({
    base: {
      properties: new Map(),
      vexcel: createVexcel({ apiKey: 'k', cache: createDiskCache(unused) }),
      matterport: null,
      buildingFacts: new Map(),
      dataDir: unused,
      edit: async () => {
        throw new Error('no op calls the edit API here')
      },
    },
  })
  const names = async (path: string) => {
    const { ops } = z.object({ ops: z.array(z.object({ name: z.string() })) }).parse(await (await app.request(path)).json())
    return ops.map(({ name }) => name)
  }
  const post = (path: string) => app.request(path, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })
  assert.deepEqual((await names('/api/proppy/ops')).toSorted(), PRIVATE.toSorted())
  assert.deepEqual((await names('/api/ops')).filter((name) => PRIVATE.includes(name)), [])
  const hidden = await post('/api/ops/area_places')
  assert.equal(hidden.status, 404)
  assert.match(JSON.stringify(await hidden.json()), /GET \/api\/ops/)
  assert.equal((await post('/api/proppy/ops/area_places')).status, 400, 'runs and rejects the empty input')
  assert.equal((await post('/api/proppy/ops/features_get')).status, 404)
  assert.equal((await app.request('http://rebound.example/api/proppy/ops')).status, 403)
})

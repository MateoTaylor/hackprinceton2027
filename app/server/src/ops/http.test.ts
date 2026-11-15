import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { z } from 'zod'
import type { Property } from '../../../shared/property.ts'
import { createApp } from '../app.ts'
import { createDiskCache } from '../cache.ts'
import { createVexcel } from '../vexcel.ts'
import { defineOp, OP_ERROR_CODES, OpError, type OpErrorCode } from './op.ts'

const property: Property = {
  id: 'commercial-1',
  kind: 'commercial',
  costarId: '1',
  name: 'Invented Tower',
  address: '1 Invented Way',
  lat: 29.76,
  lon: -95.37,
  typeLabel: 'Office',
  facts: [{ label: 'Storeys', value: '12' }],
  photoUrl: null,
  scans: [],
}

const unusedDir = join(tmpdir(), 'propstar-http-test-unused')
const base = {
  properties: new Map([[property.id, property]]),
  vexcel: createVexcel({ apiKey: 'k', cache: createDiskCache(unusedDir) }),
  matterport: null,
  dataDir: unusedDir,
}

const echo = defineOp({
  name: 'echo_get',
  summary: 'Sends back its text, with its length in detail.',
  effect: 'read',
  input: z.object({ text: z.string() }),
  output: z.object({ text: z.string() }),
  detail: z.object({ length: z.number() }),
})(async (_ctx, { text }) => ({ result: { text }, detail: { length: text.length } }))

const fails = defineOp({
  name: 'fails_with',
  summary: 'Fails with the code it is given.',
  effect: 'read',
  input: z.object({ code: z.enum(OP_ERROR_CODES) }),
  output: z.object({}),
})(async (_ctx, { code }) => {
  throw new OpError(code, 'It failed.', 'Ask for another code.')
})

const app = createApp({ base, ops: [echo, fails] })
const post = (name: string, body: string, query = '') =>
  app.request(`/api/ops/${name}${query}`, { method: 'POST', body, headers: { 'content-type': 'application/json' } })

test('GET /api/ops lists the manifest', async () => {
  const res = await app.request('/api/ops')
  assert.equal(res.status, 200)
  const { ops } = await res.json()
  assert.deepEqual(ops.map((op: { name: string }) => op.name), ['echo_get', 'fails_with'])
})

test('POST runs an op and adds detail only for ?detail=full', async () => {
  const body = JSON.stringify({ text: 'hi' })
  const plain = await post('echo_get', body)
  assert.equal(plain.status, 200)
  assert.deepEqual(await plain.json(), { ok: true, result: { text: 'hi' } })
  assert.deepEqual(await (await post('echo_get', body, '?detail=1')).json(), { ok: true, result: { text: 'hi' } })
  assert.deepEqual(await (await post('echo_get', body, '?detail=full')).json(), { ok: true, result: { text: 'hi' }, detail: { length: 2 } })
})

test('each error code has its own status', async () => {
  const expected: Record<OpErrorCode, number> = {
    invalid_input: 400,
    not_found: 404,
    not_ready: 503,
    no_data: 404,
    upstream: 502,
    conflict: 409,
    internal: 500,
  }
  for (const code of OP_ERROR_CODES) {
    const res = await post('fails_with', JSON.stringify({ code }))
    assert.equal(res.status, expected[code], code)
    assert.deepEqual(await res.json(), { ok: false, error: { code, message: 'It failed.', hint: 'Ask for another code.' } })
  }
})

test('an unknown op is a 404 whose hint names GET /api/ops', async () => {
  const res = await post('echo_gte', '{}')
  assert.equal(res.status, 404)
  const { error } = await res.json()
  assert.equal(error.code, 'not_found')
  assert.match(error.hint, /GET \/api\/ops/)
})

test('a body that is not one JSON object, or is over 64 KB, is invalid_input', async () => {
  for (const body of ['not json', '[]', 'null', JSON.stringify({ text: 'x'.repeat(64 * 1024) })]) {
    const res = await post('echo_get', body)
    assert.equal(res.status, 400, body.slice(0, 20))
    assert.equal((await res.json()).error.code, 'invalid_input')
  }
})

test('property_get answers with the curated property, or not_found for an unknown id', async () => {
  const real = createApp({ base })
  const ask = (propertyId: string) =>
    real.request('/api/ops/property_get', { method: 'POST', body: JSON.stringify({ propertyId }), headers: { 'content-type': 'application/json' } })
  assert.deepEqual(await (await ask('commercial-1')).json(), { ok: true, result: property })
  const missing = await ask('nope')
  assert.equal(missing.status, 404)
  assert.equal((await missing.json()).error.code, 'not_found')
})

test('the host check covers the op routes', async () => {
  assert.equal((await app.request('http://rebound.example/api/ops')).status, 403)
})

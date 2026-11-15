import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { z } from 'zod'
import type { Property } from '../../../shared/property.ts'
import { createDiskCache } from '../cache.ts'
import { createVexcel } from '../vexcel.ts'
import { defineOp, type Op, type OpContext, OpError, RESULT_MAX_CHARS, requireProperty, runOp, Source } from './op.ts'

const property: Property = {
  id: 'commercial-1',
  kind: 'commercial',
  costarId: '1',
  name: 'Invented Tower',
  address: '1 Invented Way',
  lat: 29.76,
  lon: -95.37,
  typeLabel: 'Office',
  facts: [],
  photoUrl: null,
  scans: [],
}

const unusedDir = join(tmpdir(), 'propstar-op-test-unused')
const ctx: OpContext = {
  properties: new Map([[property.id, property]]),
  vexcel: createVexcel({ apiKey: 'k', cache: createDiskCache(unusedDir) }),
  dataDir: unusedDir,
  call: async () => {
    throw new Error('no op calls another here')
  },
}

const Point = z.tuple([z.number(), z.number()])

const outline = defineOp({
  name: 'outline_get',
  summary: 'The name and an invented outline of one property.',
  effect: 'read',
  input: z.strictObject({ propertyId: z.string(), padding: z.int().min(0).default(0) }),
  output: z.object({ name: z.string(), source: Source, note: z.string() }),
  detail: z.object({ ring: z.array(Point) }),
})(async (ctx, { propertyId, padding }) => ({
  result: { ...requireProperty(ctx, propertyId), source: 'inferred', note: 'x'.repeat(padding) },
  detail: { ring: [[0, 0], [10, 0], [10, 10]] },
}))

const failing = (name: string, run: () => Promise<{ result: { name: string } }>) =>
  defineOp({ name, summary: 'Fails on purpose.', effect: 'read', input: z.object({}), output: z.object({ name: z.string().min(1) }) })(run)

const registry: Op[] = [outline, failing('fails_op', async () => ({ result: { name: '' } }))]

defineOp({ name: 'wrong_literal', summary: 'Returns a source that is not a Source.', effect: 'read', input: z.object({}), output: z.object({ source: Source }) })(
  // @ts-expect-error 'guess' is not a Source.
  async () => ({ result: { source: 'guess' } }),
)

test('returns the parsed result, without keys the output schema does not name and without detail unless asked', async () => {
  const envelope = await runOp(outline, ctx, { propertyId: property.id })
  assert.deepEqual(envelope, { ok: true, result: { name: 'Invented Tower', source: 'inferred', note: '' } })
})

test('returns the parsed detail when asked', async () => {
  const envelope = await runOp(outline, ctx, { propertyId: property.id }, { detail: true })
  assert.ok(envelope.ok)
  assert.deepEqual(envelope.detail, { ring: [[0, 0], [10, 0], [10, 10]] })
})

test('a bad input is invalid_input, naming the first failing path and pointing at GET /api/ops', async () => {
  const nested = await runOp(outline, ctx, { propertyId: property.id, padding: -1 })
  assert.ok(!nested.ok)
  assert.equal(nested.error.code, 'invalid_input')
  assert.match(nested.error.message, /^padding: /)
  assert.match(nested.error.hint, /GET \/api\/ops/)

  const root = await runOp(outline, ctx, 'not an object')
  assert.ok(!root.ok)
  assert.match(root.error.message, /^input: /)
})

test('an OpError from run passes through with its code, message and hint', async () => {
  const envelope = await runOp(outline, ctx, { propertyId: 'commercial-0' })
  assert.deepEqual(envelope, {
    ok: false,
    error: { code: 'not_found', message: 'No property has the id "commercial-0".', hint: 'List the valid ids with GET /api/properties.' },
  })
})

test('any other exception is internal, and neither the envelope nor the log holds its text', async (t) => {
  const log = t.mock.method(console, 'error', () => {})
  const op = failing('throws_op', async () => {
    throw new TypeError('secret at /Users/someone/.env?key=abc')
  })
  const envelope = await runOp(op, ctx, {})
  assert.ok(!envelope.ok)
  assert.equal(envelope.error.code, 'internal')
  assert.doesNotMatch(JSON.stringify(envelope), /secret/)
  assert.deepEqual(
    log.mock.calls.map((call) => call.arguments),
    [['op throws_op failed: TypeError']],
  )
})

test('a result that does not match the output schema is internal', async (t) => {
  t.mock.method(console, 'error', () => {})
  const envelope = await runOp(failing('mismatch_op', async () => ({ result: { name: '' } })), ctx, {})
  assert.ok(!envelope.ok)
  assert.equal(envelope.error.code, 'internal')
})

test('a result longer than RESULT_MAX_CHARS as JSON is internal', async (t) => {
  t.mock.method(console, 'error', () => {})
  const envelope = await runOp(outline, ctx, { propertyId: property.id, padding: RESULT_MAX_CHARS })
  assert.ok(!envelope.ok)
  assert.equal(envelope.error.code, 'internal')
})

test('a detail that does not match the detail schema is internal, but only when detail is asked for', async (t) => {
  t.mock.method(console, 'error', () => {})
  const op = defineOp({
    name: 'bad_detail',
    summary: 'Returns a detail that breaks its schema.',
    effect: 'read',
    input: z.object({}),
    output: z.object({}),
    detail: z.object({ ring: z.array(Point).min(3) }),
  })(async () => ({ result: {}, detail: { ring: [] } }))
  assert.deepEqual(await runOp(op, ctx, {}), { ok: true, result: {} })
  const envelope = await runOp(op, ctx, {}, { detail: true })
  assert.ok(!envelope.ok)
  assert.equal(envelope.error.code, 'internal')
})

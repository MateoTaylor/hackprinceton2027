import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { z } from 'zod'
import { createDiskCache } from '../cache.ts'
import { createVexcel } from '../vexcel.ts'
import { defineOp, type Op, OpError } from './op.ts'
import { createRegistry, type OpBase } from './registry.ts'

const unusedDir = join(tmpdir(), 'propstar-registry-test-unused')
const base: OpBase = {
  properties: new Map(),
  vexcel: createVexcel({ apiKey: 'k', cache: createDiskCache(unusedDir) }),
  dataDir: unusedDir,
}

const area = defineOp({
  name: 'area_get',
  summary: 'An invented floor area, with the shape behind it in detail.',
  effect: 'read',
  input: z.object({ side: z.number(), unit: z.enum(['m', 'ft']).default('m') }),
  output: z.object({ area: z.number() }),
  detail: z.object({ corners: z.number() }),
})(async (_ctx, { side }) => ({ result: { area: side * side }, detail: { corners: 4 } }))

const doubled = defineOp({
  name: 'area_doubled',
  summary: 'Calls area_get and doubles its answer.',
  effect: 'read',
  input: z.object({ side: z.number() }),
  output: z.object({ area: z.number(), corners: z.number() }),
})(async (ctx, input) => {
  const { result, detail } = await ctx.call('area_get', input)
  const { area } = z.object({ area: z.number() }).parse(result)
  const { corners } = z.object({ corners: z.number() }).parse(detail)
  return { result: { area: 2 * area, corners } }
})

const missing = defineOp({
  name: 'missing_get',
  summary: 'Always finds nothing.',
  effect: 'read',
  input: z.object({}),
  output: z.object({}),
})(async () => {
  throw new OpError('no_data', 'Nothing here.', 'Try another property.')
})

const relay = defineOp({
  name: 'relay_get',
  summary: 'Passes on whatever missing_get says.',
  effect: 'read',
  input: z.object({}),
  output: z.object({}),
})(async (ctx) => {
  await ctx.call('missing_get', {})
  return { result: {} }
})

const countdown = defineOp({
  name: 'countdown',
  summary: 'Calls itself n times.',
  effect: 'read',
  input: z.object({ n: z.number().int().min(0) }),
  output: z.object({ reached: z.number() }),
})(async (ctx, { n }) => {
  if (n === 0) return { result: { reached: 0 } }
  await ctx.call('countdown', { n: n - 1 })
  return { result: { reached: n } }
})

const ops: Op[] = [area, doubled, missing, relay, countdown]
const registry = createRegistry(ops, base)

test('a bad or repeated name stops the registry at startup', () => {
  const named = (name: string) => ({ ...missing, name })
  assert.throws(() => createRegistry([named('Area_get')], base), /must match/)
  assert.throws(() => createRegistry([named('ab')], base), /must match/)
  assert.throws(() => createRegistry([named('area-get')], base), /must match/)
  assert.throws(() => createRegistry([area, named('area_get')], base), /registered twice/)
  assert.equal(createRegistry([named('abc')], base).get('abc')?.name, 'abc')
})

test('the manifest lists each op with JSON Schemas of what a caller sends and gets back', () => {
  const [entry] = registry.manifest()
  assert.deepEqual(Object.keys(entry), ['name', 'summary', 'effect', 'input', 'output'])
  assert.equal(entry.name, 'area_get')
  assert.deepEqual(entry.input.required, ['side'])
  assert.deepEqual(Object.keys(entry.output.properties ?? {}), ['area'])
  assert.ok(!JSON.stringify(entry).includes('corners'))
  assert.deepEqual(registry.manifest().map((e) => e.name), ops.map((op) => op.name))
})

test('an unknown op name is not_found and the hint names GET /api/ops', async () => {
  const answer = await registry.run('area_gte', { side: 2 })
  assert.equal(answer.ok, false)
  if (answer.ok) return
  assert.equal(answer.error.code, 'not_found')
  assert.match(answer.error.hint, /GET \/api\/ops/)
})

test('detail comes back only when asked for', async () => {
  assert.deepEqual(await registry.run('area_get', { side: 3 }), { ok: true, result: { area: 9 } })
  assert.deepEqual(await registry.run('area_get', { side: 3 }, { detail: true }), { ok: true, result: { area: 9 }, detail: { corners: 4 } })
})

test('ctx.call gives an op the result and detail of another', async () => {
  assert.deepEqual(await registry.run('area_doubled', { side: 3 }), { ok: true, result: { area: 18, corners: 4 } })
})

test('a failure inside ctx.call reaches the caller with its code, message and hint', async () => {
  assert.deepEqual(await registry.run('relay_get', {}), {
    ok: false,
    error: { code: 'no_data', message: 'Nothing here.', hint: 'Try another property.' },
  })
})

test('calls nest four deep and a fifth fails as internal', async (t) => {
  const errors = t.mock.method(console, 'error', () => {})
  assert.deepEqual(await registry.run('countdown', { n: 4 }), { ok: true, result: { reached: 4 } })
  assert.equal(errors.mock.callCount(), 0)

  const answer = await registry.run('countdown', { n: 50 })
  assert.equal(!answer.ok && answer.error.code, 'internal')
  assert.deepEqual(errors.mock.calls.map((call) => call.arguments), [['op countdown failed: CallDepthExceeded']])
})

import assert from 'node:assert/strict'
import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createDiskCache } from '../../cache.ts'
import { createVexcel } from '../../vexcel.ts'
import { type OpContext, RESULT_MAX_CHARS, runOp } from '../op.ts'
import { MAX_OBJECTS, SCENE_OPS } from './index.ts'

const [sceneGet, scenePlace, sceneMove, sceneRemove] = SCENE_OPS
const spaceId = 'L3sdz2m7jxp'
const wall = { kind: 'wall', normal: [0, 0, 1] }
const sign = { spaceId, equipmentId: 'sign_panel', position: [1.234, 3, -2], anchor: wall }

// A context whose scenes live in a fresh temp folder.
async function context(): Promise<OpContext> {
  const dataDir = await mkdtemp(join(tmpdir(), 'propstar-scene-test-'))
  return {
    properties: new Map(),
    vexcel: createVexcel({ apiKey: 'k', cache: createDiskCache(join(dataDir, 'cache')) }),
    matterport: null,
    buildingFacts: new Map(),
    dataDir,
    edit: async () => {
      throw new Error('scene ops never call the edit API')
    },
    call: async () => {
      throw new Error('scene ops never call another op')
    },
  }
}

async function ok(ctx: OpContext, op: (typeof SCENE_OPS)[number], input: object) {
  const envelope = await runOp(op, ctx, input)
  assert.ok(envelope.ok, envelope.ok ? '' : envelope.error.message)
  return envelope.result as { version: number; objectCount: number; objects: { id: string; yawDeg: number; sizeM?: object; groundY?: number; position: number[] }[] }
}

async function code(ctx: OpContext, op: (typeof SCENE_OPS)[number], input: object) {
  const envelope = await runOp(op, ctx, input)
  assert.ok(!envelope.ok)
  return envelope.error.code
}

test('a placed sign gets the default size, faces along its wall and bumps the version', async () => {
  const ctx = await context()
  const placed = await ok(ctx, scenePlace, sign)
  assert.equal(placed.version, 1)
  const [object] = placed.objects
  assert.deepEqual(object.sizeM, { widthM: 2.4, heightM: 0.6 })
  assert.equal(object.yawDeg, 270)
  assert.deepEqual(object.position, [1.23, 3, -2])
  assert.deepEqual((await ok(ctx, sceneGet, { spaceId })).objects, placed.objects)
})

test('a stale expectedVersion answers conflict and saves nothing', async () => {
  const ctx = await context()
  await ok(ctx, scenePlace, sign)
  assert.equal(await code(ctx, scenePlace, { ...sign, expectedVersion: 0 }), 'conflict')
  assert.equal((await ok(ctx, sceneGet, { spaceId })).objectCount, 1)
})

test('a spaceId that is a path is refused and writes nothing', async () => {
  const ctx = await context()
  assert.equal(await code(ctx, scenePlace, { ...sign, spaceId: '../../etc' }), 'invalid_input')
  assert.deepEqual(await readdir(ctx.dataDir), [])
})

test('a sign needs a wall anchor, and only a sign takes a size', async () => {
  const ctx = await context()
  assert.equal(await code(ctx, scenePlace, { ...sign, anchor: undefined }), 'invalid_input')
  assert.equal(await code(ctx, scenePlace, { ...sign, anchor: { kind: 'floor', normal: [0, 1, 0] } }), 'invalid_input')
  assert.equal(await code(ctx, scenePlace, { spaceId, equipmentId: 'slab_scissor_19ft', position: [0, 0, 0], sizeM: { widthM: 1, heightM: 1 } }), 'invalid_input')
  assert.equal(await code(ctx, scenePlace, { ...sign, equipmentId: 'nope' }), 'invalid_input')
})

test('moving a sign drops its measured ground, and resizing it keeps it', async () => {
  const ctx = await context()
  const [{ id: objectId }] = (await ok(ctx, scenePlace, { ...sign, groundY: 0.5 })).objects
  const resized = await ok(ctx, sceneMove, { spaceId, objectId, sizeM: { widthM: 3, heightM: 1 } })
  assert.equal(resized.objects[0].groundY, 0.5)
  assert.deepEqual(resized.objects[0].sizeM, { widthM: 3, heightM: 1 })
  const moved = await ok(ctx, sceneMove, { spaceId, objectId, position: [0, 4, 0] })
  assert.equal(moved.objects[0].groundY, undefined)
  assert.equal(await code(ctx, sceneMove, { spaceId, objectId: 'o-nope', position: [0, 0, 0] }), 'not_found')
  assert.equal((await ok(ctx, sceneRemove, { spaceId, objectId })).objectCount, 0)
})

test('a full scene fits in a result, and one more object is refused', async () => {
  const ctx = await context()
  const widest = { ...sign, position: [-123.45, -123.45, -123.45], anchor: { kind: 'wall', normal: [-0.667, -0.333, -0.667] }, sizeM: { widthM: 12.34, heightM: 12.34 }, groundY: -123.45, yawDeg: 123.4 }
  for (let n = 0; n < MAX_OBJECTS; n++) await ok(ctx, scenePlace, widest)
  const full = await ok(ctx, sceneGet, { spaceId })
  assert.equal(full.objectCount, MAX_OBJECTS)
  assert.ok(JSON.stringify(full).length <= RESULT_MAX_CHARS)
  assert.equal(await code(ctx, scenePlace, widest), 'invalid_input')
  assert.equal(await code(ctx, scenePlace, { ...sign, anchor: { kind: 'wall', normal: [0, 1, 0] } }), 'invalid_input')
})

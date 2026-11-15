import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createDiskCache } from '../cache.ts'
import { EQUIPMENT_OPS } from '../ops/equipment/index.ts'
import { type OpContext, RESULT_MAX_CHARS, runOp } from '../ops/op.ts'
import { createVexcel } from '../vexcel.ts'
import { EQUIPMENT } from './equipment.ts'

const DIMENSIONS = ['platformHeightM', 'workingHeightM', 'outreachM', 'lengthM', 'widthM', 'stowedHeightM', 'weightKg'] as const

test('every equipment id is unique', () => {
  assert.equal(new Set(EQUIPMENT.map(({ id }) => id)).size, EQUIPMENT.length)
})

test('every dimension is positive or null', () => {
  for (const row of EQUIPMENT) {
    for (const key of DIMENSIONS) {
      const value = row[key]
      assert.ok(value === null || value > 0, `${row.id}.${key} is ${value}`)
    }
  }
})

test('only signs mount on a wall', () => {
  for (const row of EQUIPMENT) assert.equal(row.mount === 'wall', row.class === 'sign', row.id)
})

test('equipment_list returns every row within the result limit', async () => {
  const unusedDir = join(tmpdir(), 'propstar-equipment-test-unused')
  const ctx: OpContext = {
    properties: new Map(),
    vexcel: createVexcel({ apiKey: 'k', cache: createDiskCache(unusedDir) }),
    dataDir: unusedDir,
    call: async () => {
      throw new Error('equipment_list calls no other op')
    },
  }
  const envelope = await runOp(EQUIPMENT_OPS[0], ctx, {})
  assert.ok(envelope.ok)
  assert.equal(envelope.result.items.length, EQUIPMENT.length)
  assert.ok(JSON.stringify(envelope.result).length <= RESULT_MAX_CHARS)
})

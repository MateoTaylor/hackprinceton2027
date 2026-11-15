import assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod'
import { createViewStore } from '../view/store.ts'
import { OPS } from './index.ts'
import { createViewOps } from './view/index.ts'

const ALL = [...OPS, ...createViewOps(createViewStore())]

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

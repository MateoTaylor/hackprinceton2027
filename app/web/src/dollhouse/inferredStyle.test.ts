import assert from 'node:assert/strict'
import { test } from 'node:test'
import { protoTone } from './inferredStyle.ts'

test('confidence falls into three grey tones', () => {
  assert.deepEqual(
    [0, 0.19, 0.2, 0.39, 0.4, 1].map(protoTone),
    ['low', 'low', 'mid', 'mid', 'high', 'high'],
  )
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { floorTone } from './floorTone.ts'

test('a label takes the first tone whose keyword it contains', () => {
  assert.equal(floorTone('Bathroom'), 'wet')
  assert.equal(floorTone('Conference Room'), 'meet')
  assert.equal(floorTone('Open Office'), 'work')
  assert.equal(floorTone('Dining Hall'), 'living')
  assert.equal(floorTone('Xyz'), 'other')
})

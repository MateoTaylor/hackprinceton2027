import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FIXTURES } from '../../../server/src/model/fixtures.ts'
import { massingParts, toScene } from './massing.ts'

test('one part per shell volume and per neighbour', () => {
  assert.equal(massingParts(FIXTURES.officeTower).length, 4)
  assert.equal(massingParts(FIXTURES.warehouse).length, 2)
  assert.equal(massingParts(FIXTURES.apartment).length, 3)
})

test('a volume spans its baseM to its topM in the high tone', () => {
  for (const building of Object.values(FIXTURES)) {
    const parts = massingParts(building)
    for (const volume of building.shell.volumes) {
      const part = parts.find(({ id }) => id === volume.id)
      assert.deepEqual(part && [part.baseM, part.topM, part.tone], [volume.baseM, volume.topM, 'high'])
    }
  }
})

test('a neighbour stands from the ground to its height in the context tone', () => {
  const parts = massingParts(FIXTURES.apartment).filter(({ tone }) => tone === 'context')
  assert.deepEqual(
    parts.map(({ baseM, topM }) => [baseM, topM]),
    FIXTURES.apartment.context.map(({ heightM }) => [0, heightM]),
  )
})

test('toScene puts up on +y and north on -z', () => {
  assert.deepEqual(toScene(1, 2, 3).toArray(), [1, 3, -2])
  assert.ok(toScene(0, 1, 0).z < 0)
})

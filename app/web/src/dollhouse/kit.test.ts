import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Box3, Vector3 } from 'three'
import { FURNISHING_FOOTPRINTS, FURNISHING_KINDS } from '../../../server/src/model/furnishings.ts'
import { KIT, loadKit } from './kit.ts'

test('the kit covers every furnishing kind once', () => {
  assert.deepEqual(KIT.map(({ kind }) => kind).sort(), [...FURNISHING_KINDS].sort())
})

test('every kit shape fills its footprint within 5% and stands on the floor', () => {
  for (const [kind, { geometry }] of loadKit()) {
    geometry.computeBoundingBox()
    const box = geometry.boundingBox ?? new Box3()
    const size = box.getSize(new Vector3())
    const { widthM, depthM, heightM } = FURNISHING_FOOTPRINTS[kind]
    for (const [axis, got, want] of [['width', size.x, widthM], ['height', size.y, heightM], ['depth', size.z, depthM]] as const)
      assert.ok(Math.abs(got - want) <= want * 0.05, `${kind} ${axis} ${got} vs ${want}`)
    assert.ok(Math.abs(box.min.y) < 1e-6, `${kind} floor`)
  }
})

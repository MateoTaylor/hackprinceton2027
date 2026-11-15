import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chooseLift } from './lift.ts'
import { measureSign } from './measure.ts'

const need = { heightM: 5, outreachM: 0, ground: 'paved', overObstacle: false } as const

test('chooseLift names the smallest class that meets the need', () => {
  assert.equal(chooseLift(need)?.lift.class, 'slab_scissor')
  assert.equal(chooseLift({ ...need, ground: 'unpaved' })?.lift.class, 'rough_terrain_scissor')
  assert.equal(chooseLift({ ...need, heightM: 10, overObstacle: true })?.lift.class, 'articulating_boom')
  assert.equal(chooseLift({ ...need, outreachM: 20 })?.lift.class, 'telescopic_boom')
})

test('chooseLift offers at most three alternatives, each at least as tall as the need', () => {
  const chosen = chooseLift(need)
  assert.ok(chosen && chosen.alternatives.length === 3)
  assert.ok(chosen.alternatives.every(({ workingHeightM }) => workingHeightM >= need.heightM))
})

test('chooseLift is null when nothing reaches', () => {
  assert.equal(chooseLift({ ...need, heightM: 200 }), null)
})

test('measureSign measures from the ground to the bottom and top edges', () => {
  const sign = { position: [0, 3, 0] as [number, number, number], sizeM: { widthM: 3, heightM: 1 } }
  assert.deepEqual(measureSign({ ...sign, groundY: 0 }), { widthM: 3, heightM: 1, areaM2: 3, bottomAboveGroundM: 2.5, topAboveGroundM: 3.5, groundProblem: false })
  assert.equal(measureSign(sign).topAboveGroundM, null)
  const buried = measureSign({ ...sign, groundY: 2.8 })
  assert.equal(buried.groundProblem, true)
  assert.equal(buried.bottomAboveGroundM, null)
})

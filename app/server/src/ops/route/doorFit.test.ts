import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Opening } from '../../model/building.ts'
import { doorFit, FIT_CAP, fitConfidence } from './doorFit.ts'

const door = (widthM: number, heightM: number | null, source: Opening['source'] = 'costar', confidence = 1): Opening => ({
  id: 'd1',
  kind: 'door',
  at: [0, 0],
  widthM,
  heightM,
  bearingDeg: 90,
  spaceIds: ['a', 'b'],
  source,
  confidence,
})

const wheelchair = { widthM: 0.7, heightM: 1.4, wheeled: true }
const person = { widthM: 0.55, heightM: 1.9, wheeled: false }

test('a wide door passes at the cap', () => {
  const fit = doorFit(door(1.2, 2.1), wheelchair)
  assert.equal(fit.verdict, 'pass')
  assert.equal(fit.confidence, 0.8)
  assert.equal(fit.clearanceM, 0.5)
  assert.equal(fit.limitedBy, 'width')
})

test('a door 2 cm narrower than the payload fails with low confidence', () => {
  const fit = doorFit(door(0.68, 2.1), wheelchair)
  assert.equal(fit.verdict, 'fail')
  assert.equal(fit.clearanceM, -0.02)
  assert.ok(fit.confidence < 0.1, `confidence ${fit.confidence}`)
})

test('fit confidence never passes the cap', () => {
  assert.equal(fitConfidence(1, 1), FIT_CAP)
})

test('a low door fails on height', () => {
  const fit = doorFit(door(1.2, 1.8), person)
  assert.equal(fit.verdict, 'fail')
  assert.equal(fit.limitedBy, 'height')
  assert.equal(fit.clearanceM, -0.1)
})

test('an inferred door that fits passes with its own confidence folded in', () => {
  const fit = doorFit(door(1.2, 2.1, 'inferred', 0.3), wheelchair)
  assert.equal(fit.verdict, 'pass')
  assert.equal(fit.confidence, 0.24)
  assert.equal(fit.source, 'inferred')
})

test('a full-height opening is taken as a 2.03 m door', () => {
  const fit = doorFit(door(1.2, null), { widthM: 0.7, heightM: 2, wheeled: false })
  assert.equal(fit.limitedBy, 'height')
  assert.equal(fit.clearanceM, 0.03)
})

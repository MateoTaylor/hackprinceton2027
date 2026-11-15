import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NO_PINS, pinsFromHighlights, scoreBand } from './pins.ts'

const highlights = [
  { propertyId: 'a', score: 72 },
  { propertyId: 'b', score: null },
]

test('a highlight with no score is scoring while Proppy runs and failed after', () => {
  assert.deepEqual(Object.fromEntries(pinsFromHighlights(highlights, true)), { a: { status: 'scored', score: 72 }, b: { status: 'scoring' } })
  assert.deepEqual(Object.fromEntries(pinsFromHighlights(highlights, false)), { a: { status: 'scored', score: 72 }, b: { status: 'failed' } })
  assert.equal(pinsFromHighlights([], true), NO_PINS)
})

test('score bands follow the design system', () => {
  assert.deepEqual([100, 80, 79, 50, 49, 0].map(scoreBand), ['good', 'good', 'mid', 'mid', 'bad', 'bad'])
})

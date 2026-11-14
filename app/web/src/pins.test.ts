import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyPin, NO_PINS, parsePinEvent, scoreBand, settlePins, type Pins } from './pins.ts'

const run = (events: unknown[]): Pins =>
  events.reduce<Pins>((pins, data) => {
    const event = parsePinEvent(data)
    return event ? applyPin(pins, event) : pins
  }, NO_PINS)

test('a pin goes scoring then scored, bare or wrapped in payload', () => {
  const pins = run([
    { type: 'pin', propertyId: 'a', status: 'scoring' },
    { payload: { type: 'pin', propertyId: 'b', status: 'scoring' } },
    { type: 'pin', propertyId: 'a', status: 'scored', score: 72 },
    { payload: { type: 'pin', propertyId: 'b', status: 'failed' } },
  ])
  assert.deepEqual(Object.fromEntries(pins), { a: { status: 'scored', score: 72 }, b: { status: 'failed' } })
})

test('events that are not PinEvents change nothing', () => {
  const pins = run([
    { status: 'starting', progress: 0 },
    { type: 'pin', propertyId: 'a', status: 'scored' },
    { type: 'pin', propertyId: 'a', status: 'done' },
    { type: 'pin', propertyId: 7, status: 'scoring' },
    null,
  ])
  assert.equal(pins.size, 0)
})

test('settling turns only scoring pins failed', () => {
  const pins = run([
    { type: 'pin', propertyId: 'a', status: 'scoring' },
    { type: 'pin', propertyId: 'b', status: 'scoring' },
    { type: 'pin', propertyId: 'b', status: 'scored', score: 40 },
  ])
  assert.deepEqual(Object.fromEntries(settlePins(pins)), { a: { status: 'failed' }, b: { status: 'scored', score: 40 } })
  const settled = settlePins(pins)
  assert.equal(settlePins(settled), settled, 'nothing left to settle keeps the same map')
})

test('score bands follow the design system', () => {
  assert.deepEqual([100, 80, 79, 50, 49, 0].map(scoreBand), ['good', 'good', 'mid', 'mid', 'bad', 'bad'])
})

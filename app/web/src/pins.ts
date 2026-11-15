import type { Highlight } from '../../shared/view'

// A pin turns "scoring" when scoring starts, then "scored" or "failed".
export type PinEvent =
  | { type: 'pin'; propertyId: string; status: 'scoring' | 'failed' }
  | { type: 'pin'; propertyId: string; status: 'scored'; score: number }

export type PinState = { status: 'scoring' } | { status: 'scored'; score: number } | { status: 'failed' }
export type Pins = ReadonlyMap<string, PinState>

export const NO_PINS: Pins = new Map()

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

// Reads the `data` of a raw "custom" channel event. The server may wrap the writer's value as
// `{ payload }`, so both shapes are accepted. Anything that is not a PinEvent gives null.
export function parsePinEvent(data: unknown): PinEvent | null {
  const value = isRecord(data) && isRecord(data.payload) ? data.payload : data
  if (!isRecord(value) || value.type !== 'pin' || typeof value.propertyId !== 'string') return null
  const { propertyId, status, score } = value
  if (status === 'scoring' || status === 'failed') return { type: 'pin', propertyId, status }
  if (status === 'scored' && typeof score === 'number' && Number.isFinite(score)) return { type: 'pin', propertyId, status, score }
  return null
}

export function applyPin(pins: Pins, event: PinEvent): Pins {
  const next = new Map(pins)
  next.set(event.propertyId, event.status === 'scored' ? { status: 'scored', score: event.score } : { status: event.status })
  return next
}

// A run that errors or ends leaves no pin waiting, so anything still scoring has failed.
export function settlePins(pins: Pins): Pins {
  if (![...pins.values()].some((p) => p.status === 'scoring')) return pins
  return new Map([...pins].map(([id, p]) => [id, p.status === 'scoring' ? { status: 'failed' } : p]))
}

// The design system's score bands: 80 and above is good, 50 to 79 is mid, under 50 is bad.
export const scoreBand = (score: number) => (score >= 80 ? 'good' : score >= 50 ? 'mid' : 'bad')

// Draws the view's highlights over Proppy's pins. A highlight with no score yet shows as scoring.
export function withHighlights(pins: Pins, highlights: readonly Highlight[]): Pins {
  if (highlights.length === 0) return pins
  const next = new Map(pins)
  for (const { propertyId, score } of highlights) next.set(propertyId, score === null ? { status: 'scoring' } : { status: 'scored', score })
  return next
}

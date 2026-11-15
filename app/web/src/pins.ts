import type { Highlight } from '../../shared/view'

export type PinState = { status: 'scoring' } | { status: 'scored'; score: number } | { status: 'failed' }
export type Pins = ReadonlyMap<string, PinState>

export const NO_PINS: Pins = new Map()

// The design system's score bands: 80 and above is good, 50 to 79 is mid, under 50 is bad.
export const scoreBand = (score: number) => (score >= 80 ? 'good' : score >= 50 ? 'mid' : 'bad')

// The pins the map draws for the view's highlights. A highlight with no score yet is scoring
// while Proppy runs and failed once the run has ended.
export function pinsFromHighlights(highlights: readonly Highlight[], running: boolean): Pins {
  if (highlights.length === 0) return NO_PINS
  return new Map(highlights.map(({ propertyId, score }) => [propertyId, score !== null ? { status: 'scored', score } : running ? { status: 'scoring' } : { status: 'failed' }]))
}

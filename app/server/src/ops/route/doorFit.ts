import type { Opening } from '../../model/building.ts'

// The size of what moves along a route. A wheeled payload cannot take a stair.
export interface Payload {
  widthM: number
  heightM: number
  wheeled: boolean
}

// Whether a payload fits through one opening. `clearanceM` is the smaller of the width and height
// margins, negative when the payload is larger, and `limitedBy` names that dimension.
export interface DoorFit {
  openingId: string
  verdict: 'pass' | 'fail'
  clearanceM: number
  confidence: number
  limitedBy: 'width' | 'height'
  source: Opening['source']
}

export const PASS_CONFIDENCE = 0.5
export const FIT_CAP = 0.8
export const DEFAULT_DOOR_HEIGHT_M = 2.03

// How sure we are that a payload fits with `clearanceM` to spare, for a doorway whose measured
// free width is `freeFraction` of its opening.
export function fitConfidence(clearanceM: number, freeFraction: number) {
  return Math.min(FIT_CAP, freeFraction / (1 + Math.exp(-(clearanceM - 0.05) / 0.03)))
}

// The verdict comes from the fit alone. An inferred opening's own confidence then scales the
// reported confidence, so a guessed door that is wide enough still passes.
export function doorFit(opening: Opening, payload: Payload): DoorFit {
  const widthClearanceM = opening.widthM - payload.widthM
  const heightClearanceM = (opening.heightM ?? DEFAULT_DOOR_HEIGHT_M) - payload.heightM
  const limitedBy = heightClearanceM < widthClearanceM ? 'height' : 'width'
  const clearanceM = Math.min(widthClearanceM, heightClearanceM)
  const fit = fitConfidence(clearanceM, 1)
  return {
    openingId: opening.id,
    verdict: fit >= PASS_CONFIDENCE ? 'pass' : 'fail',
    clearanceM: round(clearanceM),
    confidence: round(opening.source === 'inferred' ? fit * opening.confidence : fit),
    limitedBy,
    source: opening.source,
  }
}

const round = (value: number) => Math.round(value * 100) / 100

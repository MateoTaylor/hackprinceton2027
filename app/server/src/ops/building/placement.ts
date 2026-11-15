import type { Connector, Opening, Point, Ring, Scan, Space, Storey } from '../../model/building.ts'
import { ringArea, ringCentroid } from '../../model/geo.ts'
import { areaOf, intersectRings, sharedArea } from './clip.ts'
import { principalAxis } from './geometry.ts'
import type { ScanFloor, ScanPlan } from './scanPlan.ts'

const OUTLINE_FIT = 0.6
const FLIP_TOLERANCE = 0.02
const SUITE_INSIDE = 0.95
const SUITE_CONFIDENCE = 0.2
const SUITE_STOREY_CONFIDENCE = 0.5
const GROUND_STOREY_CONFIDENCE = 0.3
const OVERLAP_LIMIT = 0.1
const STAIR_OVERLAP = 0.3
const DEG = Math.PI / 180

// A scan point turns counter-clockwise by `yawDeg` about the scan's origin, then moves by `tx`, `ty`.
export type Transform = Scan['transform']

// How a scan sits in the building, for either kind of fit.
type Fit = Scan extends infer S ? (S extends Scan ? Omit<S, 'modelId' | 'name' | 'storeyIndexes'> : never) : never

export type Placement =
  | {
      kind: 'placed'
      scan: Scan
      spaces: Map<number, Space[]>
      openings: Map<number, Opening[]>
      connectors: Connector[]
      assumptions: string[]
    }
  | { kind: 'unplaced'; modelId: string; name: string; reason: string }

const normalDeg = (deg: number) => ((deg % 360) + 360) % 360

// Moves a scan point into the building frame.
export function applyTransform([x, y]: Point, { tx, ty, yawDeg }: Transform): Point {
  const [cos, sin] = [Math.cos(yawDeg * DEG), Math.sin(yawDeg * DEG)]
  return [x * cos - y * sin + tx, x * sin + y * cos + ty]
}

const moveRing = (ring: Ring, transform: Transform) => ring.map((point) => applyTransform(point, transform))

// The transform that turns `outline` by `yawDeg` and puts its centroid on `target`.
function transformOnto(outline: Ring, yawDeg: number, target: Point): Transform {
  const [x, y] = applyTransform(ringCentroid(outline), { tx: 0, ty: 0, yawDeg })
  return { tx: target[0] - x, ty: target[1] - y, yawDeg: normalDeg(yawDeg) }
}

type Candidate = { transform: Transform; iou: number; inside: number }

// The four turns 90° apart that align the outline's long axis with the ring's, each scored by
// intersection over union and by the share of the outline inside the ring. The long axis is the
// long side of the smallest rectangle around each, because a Vexcel ring's longest edge is often a
// short facade step.
export function fitCandidates(outline: Ring, ring: Ring): Candidate[] {
  const base = principalAxis(ring).deg - principalAxis(outline).deg
  const target = ringCentroid(ring)
  const [outlineArea, ringAreaM2] = [ringArea(outline), ringArea(ring)]
  return [0, 90, 180, 270].map((turn) => {
    const transform = transformOnto(outline, base + turn, target)
    const shared = sharedArea([moveRing(outline, transform)], [ring])
    return { transform, iou: shared / (outlineArea + ringAreaM2 - shared), inside: shared / outlineArea }
  })
}

// The storey a scan's name points at, from a suite number such as "Suite 1000" on the tenth
// storey, or the ground storey when the name has no number. A bare number that is the street
// number at the start of `address` is not read as a suite.
//   storeyFromName('Suite 300', 12, property.address)
export function storeyFromName(name: string, storeyCount: number, address = '') {
  const street = /^\s*(\d+)\b/.exec(address)?.[1]
  const bare = [...name.matchAll(/\b(\d{3,4})\b/g)].find(([, digits]) => digits !== street)
  const match = /(?:suite|ste\.?|unit|#)\s*(\d{3,4})\b/i.exec(name) ?? bare
  const index = match ? Math.floor(Number(match[1]) / 100) - 1 : -1
  if (index >= 0 && index < storeyCount) {
    return { index, confidence: SUITE_STOREY_CONFIDENCE, assumption: `A scan's suite number ${match?.[1]} is read as storey ${index + 1}, which is unverified.` }
  }
  return { index: 0, confidence: GROUND_STOREY_CONFIDENCE, assumption: 'A scan with no usable suite number is placed on the ground storey.' }
}

const largestFloor = (floors: ScanFloor[]) => floors.reduce((best, floor) => (ringArea(floor.outline) > ringArea(best.outline) ? floor : best))

// Places one scan in the building: picks the storey from its name, fits its largest floor's
// outline to that storey's ring and moves every floor by the same transform onto consecutive
// storeys. Rings are clipped to the storey ring. `taken` holds the space rings of scans placed
// before, by storey index, and a scan overlapping them by more than 10% is not placed. `address`
// keeps the street number in a scan's name from being read as a suite.
//   const placement = placeScan(plan, property.scans[0], storeys, new Map(), property.address)
export function placeScan(plan: ScanPlan, scan: { modelId: string; name: string }, storeys: Storey[], taken: Map<number, Ring[]>, address = ''): Placement {
  const unplaced = (reason: string): Placement => ({ kind: 'unplaced', modelId: scan.modelId, name: scan.name.slice(0, 120) || scan.modelId, reason })
  if (plan.floors.length === 0) return unplaced('The scan has no floor plan with a closed room.')

  const pick = storeyFromName(scan.name, storeys.length, address)
  const main = largestFloor(plan.floors)
  const ring = storeys[pick.index].ring
  const candidates = fitCandidates(main.outline, ring)
  const best = candidates.reduce((a, b) => (b.iou > a.iou ? b : a))
  const assumptions = [pick.assumption]

  let fit: Fit
  if (best.iou >= OUTLINE_FIT) {
    const flipped = candidates[(candidates.indexOf(best) + 2) % 4]
    const flipAmbiguous = Math.abs(best.iou - flipped.iou) <= FLIP_TOLERANCE
    if (flipAmbiguous) assumptions.push('A scan fits its storey equally well turned 180°, so its orientation is a guess.')
    fit = { fit: 'outline', iou: Math.min(1, best.iou), transform: best.transform, flipAmbiguous, confidence: Math.min(best.iou, pick.confidence) }
  } else {
    const suite = candidates.reduce((a, b) => (b.inside > a.inside ? b : a))
    if (suite.inside < SUITE_INSIDE) return unplaced(`The scan's outline fits its storey at ${best.iou.toFixed(2)} and does not fit inside it as a suite.`)
    assumptions.push('A scan smaller than its storey is centred on it, because nothing fixes where the suite lies.')
    fit = { fit: 'inferred', iou: null, transform: suite.transform, flipAmbiguous: false, confidence: Math.min(SUITE_CONFIDENCE, pick.confidence) }
  }

  const storeyOf = (floor: ScanFloor) => pick.index + floor.sequence - main.sequence
  const spaces = new Map<number, Space[]>()
  const openings = new Map<number, Opening[]>()
  const provenance = { source: 'scan' as const, confidence: fit.confidence }
  for (const floor of plan.floors) {
    const index = storeyOf(floor)
    const storey = storeys[index]
    if (!storey) continue
    const placed = floor.spaces.flatMap(({ id, label, ring: spaceRing }): Space[] => {
      const [clipped] = intersectRings([moveRing(spaceRing, fit.transform)], [storey.ring])
      return clipped ? [{ id, label, ring: clipped, ...provenance }] : []
    })
    const rings = placed.map((space) => space.ring)
    const before = taken.get(index) ?? []
    if (before.length && sharedArea(rings, before) > OVERLAP_LIMIT * areaOf(rings)) {
      return unplaced('The scan overlaps a scan placed before it by more than 10%.')
    }
    const kept = new Set(placed.map(({ id }) => id))
    openings.set(
      index,
      floor.openings.flatMap((opening): Opening[] => {
        const at = applyTransform(opening.at, fit.transform)
        const bearingDeg = normalDeg(opening.bearingDeg - fit.transform.yawDeg)
        const base = { id: opening.id, at, widthM: opening.widthM, heightM: opening.heightM, bearingDeg, ...provenance }
        const [from, to] = opening.spaceIds
        if (!kept.has(from)) return []
        if (opening.kind === 'exterior_door' || to === null) return [{ ...base, kind: 'exterior_door', spaceIds: [from, null] }]
        return kept.has(to) ? [{ ...base, kind: opening.kind, spaceIds: [from, to] }] : []
      }),
    )
    spaces.set(index, placed)
  }

  const connectors = stairsAcross(plan.floors, storeyOf, spaces, scan.modelId, fit.confidence)
  const storeyIndexes = [...spaces.keys()].toSorted((a, b) => a - b)
  if (storeyIndexes.length === 0) return unplaced('No floor of the scan lands on a storey of the building.')
  return {
    kind: 'placed',
    scan: { modelId: scan.modelId, name: scan.name.slice(0, 120) || scan.modelId, storeyIndexes, ...fit },
    spaces,
    openings,
    connectors,
    assumptions,
  }
}

// Staircases that overlap in plan on consecutive floors of a scan, as one stair each with a
// landing at each staircase's centre.
function stairsAcross(floors: ScanFloor[], storeyOf: (floor: ScanFloor) => number, placed: Map<number, Space[]>, modelId: string, confidence: number) {
  const stairsOn = (floor: ScanFloor) => {
    const ids = new Set(floor.spaces.filter(({ stair }) => stair).map(({ id }) => id))
    return (placed.get(storeyOf(floor)) ?? []).filter(({ id }) => ids.has(id))
  }
  const connectors: Connector[] = []
  for (const [i, lower] of floors.entries()) {
    const upper = floors[i + 1]
    if (!upper) break
    for (const a of stairsOn(lower)) {
      const b = stairsOn(upper).find((stair) => sharedArea([a.ring], [stair.ring]) > STAIR_OVERLAP * Math.min(ringArea(a.ring), ringArea(stair.ring)))
      if (!b) continue
      connectors.push({
        id: `${modelId}-stair-${connectors.length + 1}`,
        kind: 'stair',
        landings: [
          { storeyIndex: storeyOf(lower), at: ringCentroid(a.ring), openingId: null },
          { storeyIndex: storeyOf(upper), at: ringCentroid(b.ring), openingId: null },
        ],
        source: 'scan',
        confidence,
      })
    }
  }
  return connectors
}

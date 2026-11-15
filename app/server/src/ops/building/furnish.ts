import type { Furnishing, Opening, Point, Ring, Space, Storey } from '../../model/building.ts'
import { FURNISHING_FOOTPRINTS, type FurnishingKind } from '../../model/furnishings.ts'
import { pointInRing, ringArea, ringBounds } from '../../model/geo.ts'
import { intersectRings } from './clip.ts'
import { mulberry32, hashSeed } from './gapFill.ts'
import { orientedRect, principalAxis, rotate } from './geometry.ts'

type Along = 'wall' | 'centre' | 'rows'
type Item = { kind: FurnishingKind; count: number; along: Along }

// A space label to the furnishings it holds. The first pattern that matches the label wins, and a
// space whose label matches none stays empty. A `wall` or `centre` count is per 40 m² of floor.
export const FURNISHING_TEMPLATES: [RegExp, Item[]][] = [
  [/conference|meeting/i, [{ kind: 'conference_table', count: 1, along: 'centre' }, { kind: 'chair', count: 6, along: 'centre' }, { kind: 'plant', count: 1, along: 'wall' }]],
  [/kitchen|break|pantry/i, [{ kind: 'counter', count: 2, along: 'wall' }, { kind: 'sink', count: 1, along: 'wall' }, { kind: 'table', count: 1, along: 'centre' }, { kind: 'chair', count: 2, along: 'centre' }]],
  [/bath|restroom|toilet|wc|powder/i, [{ kind: 'toilet', count: 1, along: 'wall' }, { kind: 'sink', count: 1, along: 'wall' }]],
  [/bed/i, [{ kind: 'bed', count: 1, along: 'wall' }, { kind: 'shelf', count: 1, along: 'wall' }]],
  [/living|family|lounge|den/i, [{ kind: 'sofa', count: 1, along: 'wall' }, { kind: 'table', count: 1, along: 'centre' }, { kind: 'plant', count: 1, along: 'wall' }]],
  [/lobby|reception|entry|foyer/i, [{ kind: 'counter', count: 1, along: 'centre' }, { kind: 'sofa', count: 2, along: 'wall' }, { kind: 'plant', count: 2, along: 'wall' }]],
  [/apartment|unit/i, [{ kind: 'bed', count: 1, along: 'wall' }, { kind: 'sofa', count: 1, along: 'wall' }, { kind: 'counter', count: 1, along: 'wall' }, { kind: 'table', count: 1, along: 'centre' }]],
  [/office|work/i, [{ kind: 'desk', count: 2, along: 'wall' }, { kind: 'chair', count: 2, along: 'centre' }, { kind: 'shelf', count: 1, along: 'wall' }, { kind: 'plant', count: 1, along: 'wall' }]],
  [/warehouse|storage|stock/i, [{ kind: 'rack', count: 1, along: 'rows' }, { kind: 'pallet', count: 4, along: 'centre' }]],
  [/plant floor|factory|production|manufactur|mechanical/i, [{ kind: 'machine', count: 2, along: 'centre' }, { kind: 'crate', count: 3, along: 'wall' }]],
]

const MAX_PER_SPACE = 40
const PER_AREA_M2 = 40
const OPENING_CLEAR_M = 0.9
const WALL_GAP_M = 0.05
const WALL_STEP_M = 0.6
const CENTRE_STEP_M = 1.2
const AISLE_M = 3.5
const RACK_GAP_M = 0.1
const INSIDE = 0.995
const CONFIDENCE = { scanned: 0.3, generated: 0.15 }

const normalDeg = (deg: number) => ((deg % 360) + 360) % 360

// The rectangle a furnishing fills on the floor.
export const footprintOf = ({ kind, at, yawDeg }: Pick<Furnishing, 'kind' | 'at' | 'yawDeg'>) =>
  orientedRect(at, yawDeg, FURNISHING_FOOTPRINTS[kind].widthM, FURNISHING_FOOTPRINTS[kind].depthM)

// The floor kept clear in front of and behind an opening, as wide as the opening plus the
// clearance on each side.
export function clearanceOf({ at, widthM, bearingDeg }: Pick<Opening, 'at' | 'widthM' | 'bearingDeg'>): Ring {
  return orientedRect(at, normalDeg(-bearingDeg), widthM + 2 * OPENING_CLEAR_M, 2 * OPENING_CLEAR_M)
}

const shuffle = <T>(items: T[], random: () => number) => {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

type Spot = { at: Point; yawDeg: number }

// Spots along the walls, with the furnishing's width along the wall and its back against it.
function wallSpots(ring: Ring, kind: FurnishingKind): Spot[] {
  const { widthM, depthM } = FURNISHING_FOOTPRINTS[kind]
  return ring.flatMap((a, i) => {
    const b = ring[(i + 1) % ring.length]
    const length = Math.hypot(b[0] - a[0], b[1] - a[1])
    if (length < widthM) return []
    const [ux, uy] = [(b[0] - a[0]) / length, (b[1] - a[1]) / length]
    const inset = depthM / 2 + WALL_GAP_M
    const yawDeg = normalDeg((Math.atan2(uy, ux) * 180) / Math.PI)
    const steps = Math.floor((length - widthM) / WALL_STEP_M)
    return Array.from({ length: steps + 1 }, (_, k): Spot => {
      const t = widthM / 2 + k * WALL_STEP_M
      return { at: [a[0] + ux * t - uy * inset, a[1] + uy * t + ux * inset], yawDeg }
    })
  })
}

// Spots on a grid across the floor, turned to the space's long axis.
function centreSpots(ring: Ring): Spot[] {
  const yawDeg = normalDeg(principalAxis(ring).deg)
  const { minX, minY, maxX, maxY } = ringBounds(ring)
  const spots: Spot[] = []
  for (let x = minX + CENTRE_STEP_M / 2; x < maxX; x += CENTRE_STEP_M) {
    for (let y = minY + CENTRE_STEP_M / 2; y < maxY; y += CENTRE_STEP_M) if (pointInRing([x, y], ring)) spots.push({ at: [x, y], yawDeg })
  }
  return spots
}

// Spots in rows along the space's long axis, with an aisle between rows.
function rowSpots(ring: Ring, kind: FurnishingKind): Spot[] {
  const { widthM, depthM } = FURNISHING_FOOTPRINTS[kind]
  const { deg } = principalAxis(ring)
  const turned = ring.map((point) => rotate(point, -deg))
  const { minX, minY, maxX, maxY } = ringBounds(turned)
  const spots: Spot[] = []
  for (let y = minY + AISLE_M + depthM / 2; y + depthM / 2 < maxY - AISLE_M / 2; y += depthM + AISLE_M) {
    for (let x = minX + AISLE_M / 2 + widthM / 2; x + widthM / 2 < maxX - AISLE_M / 2; x += widthM + RACK_GAP_M) {
      spots.push({ at: rotate([x, y], deg), yawDeg: normalDeg(deg) })
    }
  }
  return spots
}

type Placed = Omit<Furnishing, 'id'>

// The furnishings of one space from its label, in the order they were placed. A footprint lies
// inside the space, overlaps no other one and keeps clear of every opening. The same seed gives
// the same list.
//   const items = furnishSpace(space, storey.openings, hashSeed(space.id))
export function furnishSpace(space: Space, openings: Opening[], seed: number): Placed[] {
  const items = FURNISHING_TEMPLATES.find(([pattern]) => pattern.test(space.label))?.[1]
  if (!items) return []
  const random = mulberry32(seed)
  const scale = Math.max(1, Math.floor(ringArea(space.ring) / PER_AREA_M2))
  const blocked = openings.map(clearanceOf)
  const confidence = space.source === 'inferred' ? CONFIDENCE.generated : CONFIDENCE.scanned
  const placed: { ring: Ring; item: Placed }[] = []
  const fits = (ring: Ring) => {
    if (!ring.every((corner) => pointInRing(corner, space.ring, 0.01))) return false
    const area = ringArea(ring)
    const inside = intersectRings([ring], [space.ring]).reduce((sum, part) => sum + ringArea(part), 0)
    if (inside < INSIDE * area) return false
    const clashes = [...blocked, ...placed.map(({ ring: other }) => other)]
    return !clashes.length || intersectRings([ring], clashes).length === 0
  }
  for (const { kind, count, along } of items) {
    const wanted = along === 'rows' ? MAX_PER_SPACE : count * scale
    const spots = along === 'wall' ? shuffle(wallSpots(space.ring, kind), random) : along === 'centre' ? shuffle(centreSpots(space.ring), random) : rowSpots(space.ring, kind)
    let added = 0
    for (const { at, yawDeg } of spots) {
      if (added >= wanted || placed.length >= MAX_PER_SPACE) break
      const ring = footprintOf({ kind, at, yawDeg })
      if (!fits(ring)) continue
      placed.push({ ring, item: { kind, spaceId: space.id, at, yawDeg, source: 'inferred', confidence } })
      added++
    }
  }
  return placed.map(({ item }) => item)
}

// A storey with every space furnished, the furnishings numbered `f-<storey>-<n>`.
export function furnishStorey(storey: Storey): Storey {
  const furnishings = storey.spaces
    .flatMap((space) => furnishSpace(space, storey.openings, hashSeed(space.id)))
    .map((item, n): Furnishing => ({ id: `f-${storey.index}-${n + 1}`, ...item }))
  return { ...storey, furnishings }
}

export const FURNISHING_ASSUMPTION = 'Furnishings are drawn from room labels, not from the scans, which hold no furniture.'

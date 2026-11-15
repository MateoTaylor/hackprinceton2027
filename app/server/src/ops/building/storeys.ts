import type { Property } from '../../../../shared/property.ts'
import type { BuildingModel, Storey } from '../../model/building.ts'
import { pointInRing, ringArea, ringCentroid } from '../../model/geo.ts'
import type { BuildingFacts } from '../../properties.ts'
import { unionRings } from './clip.ts'

export const STOREY_HEIGHT_DEFAULT_M = { commercial: 3.6, residential: 3.0 }

const FT_TO_M = 0.3048
const SF_TO_M2 = FT_TO_M ** 2
const COSTAR_CONFIDENCE = 0.8
const INFERRED_CONFIDENCE = 0.4
const AREA_MISMATCH = 0.25
// CoStar FloorName codes: 24 is the first storey and 25 the second. Code 26 is left out of the
// count (78 buildings list 25 and 27 without 26, and the worked example's 12 storeys are 24, 25
// and 27 to 36), so the third storey is 27.
const FIRST_FLOOR_CODE = 24
const SKIPPED_CODE = 26

const codeOf = (index: number) => (index < SKIPPED_CODE - FIRST_FLOOR_CODE ? FIRST_FLOOR_CODE + index : FIRST_FLOOR_CODE + index + 1)

// The display label of a storey. Every storey reads "Floor <n>", counted from 1 at the ground.
//   storeyLabel(0) // 'Floor 1'
export const storeyLabel = (index: number) => `Floor ${index + 1}`

type Facts = Pick<BuildingFacts, 'stories' | 'slabToSlabFt' | 'floors'>

// The storeys of a building from its shell and its CoStar facts, each with empty spaces. A storey's
// ring is the union of the volumes that rise above its floor, the part that holds the tallest
// volume, so a podium that touches a tower widens its low storeys and a separate low building
// beside it is left out.
//   const { storeys, assumptions } = stackStoreys(shell, ctx.buildingFacts.get(property.id), property)
export function stackStoreys(shell: BuildingModel['shell'], facts: Facts | undefined, property: Pick<Property, 'kind'>) {
  const assumptions: string[] = []
  const slabM = facts?.slabToSlabFt ? facts.slabToSlabFt * FT_TO_M : null
  let heightM = slabM ?? STOREY_HEIGHT_DEFAULT_M[property.kind]
  const counted = facts?.stories && facts.stories > 0 ? Math.round(facts.stories) : null
  const count = counted ?? Math.max(1, Math.floor(shell.heightM / heightM))
  if (!slabM) assumptions.push(`CoStar has no slab-to-slab height, so each storey is taken as ${heightM} m.`)
  if (!counted) assumptions.push(`CoStar has no storey count, so ${count} storeys are taken from the ${shell.heightM.toFixed(1)} m shell.`)

  const stackM = count * heightM
  let heightInferred = !slabM
  if (stackM > shell.heightM) {
    heightM = shell.heightM / count
    heightInferred = true
    assumptions.push(`${count} storeys of the slab height would stand ${stackM.toFixed(1)} m, over the ${shell.heightM.toFixed(1)} m shell, so each is ${heightM.toFixed(2)} m.`)
  } else if (shell.heightM - stackM > heightM) {
    assumptions.push(`The shell is ${shell.heightM.toFixed(1)} m and ${count} storeys stand ${stackM.toFixed(1)} m. The rest is taken as roof plant.`)
  }

  // Vexcel's primary flag can sit on a low neighbour of the tower, so the tallest volume anchors
  // every storey and the storeys stack on one footprint.
  const primary = shell.volumes.reduce((a, b) => (b.topM > a.topM || (b.topM === a.topM && b.primary) ? b : a))
  const inside = ringCentroid(primary.ring)
  const sizeOf = new Map(facts?.floors.map(({ code, sizeSf }) => [code, sizeSf]))
  let mismatched = 0
  const inferred = heightInferred || !counted
  const storeys = Array.from({ length: count }, (_, index): Storey => {
    const elevationM = index * heightM
    const rising = shell.volumes.filter(({ topM }) => topM > elevationM).map(({ ring }) => ring)
    const parts = unionRings(rising.length ? rising : [primary.ring])
    const ring = parts.find((part) => pointInRing(inside, part)) ?? parts[0] ?? primary.ring
    const sizeSf = sizeOf.get(codeOf(index))
    if (sizeSf && Math.abs(ringArea(ring) - sizeSf * SF_TO_M2) > AREA_MISMATCH * sizeSf * SF_TO_M2) mismatched++
    return {
      index,
      label: storeyLabel(index),
      elevationM,
      heightM,
      ring,
      source: inferred ? 'inferred' : 'costar',
      confidence: inferred ? INFERRED_CONFIDENCE : COSTAR_CONFIDENCE,
      spaces: [],
      openings: [],
      furnishings: [],
    }
  })
  if (mismatched) assumptions.push(`${mismatched} storeys differ from CoStar's floor area by over 25%. The Vexcel outline is kept.`)
  return { storeys, assumptions }
}

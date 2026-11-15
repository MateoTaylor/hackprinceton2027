import type { Property } from '../../../../shared/property.ts'
import type { BuildingModel, Volume } from '../../model/building.ts'
import { orientCcw, pointInRing, ringCentroid, toEnu } from '../../model/geo.ts'
import type { ExtractFeature } from '../../vexcel.ts'
import { OpError } from '../op.ts'

const HEIGHT = 'roof-characteristics.height'
const ELEVATION = 'roof-characteristics.elevation'
const PRIMARY_MIN_HEIGHT_M = 3
const NEIGHBOUR_DEFAULT_HEIGHT_M = 6
// Vexcel measures a structure from aerial imagery, so its footprint and height are close but not
// surveyed.
const VEXCEL_CONFIDENCE = 0.9

export type Shell = Pick<BuildingModel, 'origin' | 'shell' | 'context' | 'assumptions'>

const numberAt = ({ attributes }: ExtractFeature, key: string) => {
  const value = attributes[key]
  return typeof value === 'number' ? value : null
}

const capturesNewestFirst = (features: ExtractFeature[]) =>
  [...Map.groupBy(features, ({ capturedAt }) => capturedAt).values()].toSorted(([a], [b]) => b.capturedAt.localeCompare(a.capturedAt))

const heightOf = (feature: ExtractFeature) => {
  const height = numberAt(feature, HEIGHT)
  return height !== null && height > 0 ? height : null
}

const tallestPrimary = (features: ExtractFeature[]) =>
  features
    .flatMap((feature) => {
      const heightM = heightOf(feature)
      return feature.primary && heightM !== null ? [{ feature, heightM }] : []
    })
    .toSorted((a, b) => b.heightM - a.heightM)[0]

// The structures of the newest capture whose primary structure stands over 3 m, from the
// unsorted captures `vexcel.extract` returns for a point. Throws `no_data` when none qualifies.
//   const own = pickCapture(await ctx.vexcel.extract(lat, lon, { include: ['precomputed', 'calculated'] }))
export function pickCapture(features: ExtractFeature[]): ExtractFeature[] {
  const newest = capturesNewestFirst(features).find((structures) => (tallestPrimary(structures)?.heightM ?? 0) > PRIMARY_MIN_HEIGHT_M)
  if (newest) return newest
  throw new OpError('no_data', 'Vexcel has no measured building at this property.', 'Pick a property with a building that Vexcel has measured from the air.')
}

// The outside of a building from one capture of its own structures (`pickCapture`) and the
// structures around it from every capture. Vexcel redraws a structure in each capture with a new
// id, so a neighbour whose centre lies inside the building or inside a neighbour from a newer
// capture is dropped. Structures of one capture may overlap, as a tower stands on its podium.
export function buildShell(property: Pick<Property, 'lat' | 'lon'>, own: ExtractFeature[], neighbours: ExtractFeature[]): Shell {
  const primary = tallestPrimary(own)
  if (!primary) throw new RangeError('buildShell needs a capture from pickCapture')

  const assumptions: string[] = []
  const roofElevation = numberAt(primary.feature, ELEVATION)
  if (roofElevation === null) assumptions.push('Vexcel gave no roof elevation, so the ground is taken to be at 0 m.')
  const origin = { lat: property.lat, lon: property.lon, groundElevationM: roofElevation === null ? 0 : roofElevation - primary.heightM }
  const ringOf = ({ ring }: ExtractFeature) => orientCcw(ring.map((position) => toEnu(origin, position)))

  const measured = own.flatMap((feature) => {
    const topM = heightOf(feature)
    return topM === null ? [] : [{ feature, topM }]
  })
  if (measured.length < own.length) {
    assumptions.push(`${own.length - measured.length} of the building's ${own.length} structures had no measured height and were left out.`)
  }
  const volumes = measured.map(
    ({ feature, topM }): Volume => ({
      id: `volume-${feature.id}`,
      ring: ringOf(feature),
      baseM: 0,
      topM,
      primary: feature.primary,
      source: 'vexcel',
      confidence: VEXCEL_CONFIDENCE,
    }),
  )

  const taken = volumes.map(({ ring }) => ring)
  const context: Shell['context'] = []
  let unmeasured = 0
  for (const structures of capturesNewestFirst(neighbours)) {
    const fresh = structures
      .map((feature) => ({ ring: ringOf(feature), heightM: heightOf(feature) }))
      .filter(({ ring }) => !taken.some((other) => pointInRing(ringCentroid(ring), other)))
    taken.push(...fresh.map(({ ring }) => ring))
    for (const { ring, heightM } of fresh) {
      if (heightM === null) unmeasured++
      context.push({ ring, heightM: heightM ?? NEIGHBOUR_DEFAULT_HEIGHT_M })
    }
  }
  if (unmeasured > 0) {
    assumptions.push(`${unmeasured} of ${context.length} neighbours had no measured height and are drawn ${NEIGHBOUR_DEFAULT_HEIGHT_M} m tall.`)
  }

  return { origin, shell: { heightM: Math.max(...volumes.map(({ topM }) => topM)), volumes }, context, assumptions }
}

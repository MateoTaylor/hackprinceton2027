import { differenceD, EndType, FillRule, inflatePathsD, intersectD, JoinType, unionD, type PathD } from 'clipper2-ts'
import type { Point, Ring } from '../../model/building.ts'
import { orientCcw, ringArea } from '../../model/geo.ts'

const PRECISION = 3
const MIN_AREA_M2 = 0.01
const MITER_LIMIT = 4

const toPath = (ring: Ring): PathD => ring.map(([x, y]) => ({ x, y }))
const signedArea = (path: PathD) => ringArea(path.map(({ x, y }): Point => [x, y]))

// Clipper's outer paths, as rings counter-clockwise and largest first. Holes are dropped.
const outerRings = (paths: PathD[]) =>
  paths
    .filter((path) => path.length >= 3 && signedArea(path) > MIN_AREA_M2)
    .map((path) => orientCcw(path.map(({ x, y }): Point => [x, y])))
    .toSorted((a, b) => ringArea(b) - ringArea(a))

// The union of `rings`.
export const unionRings = (rings: Ring[]) => outerRings(unionD(rings.map(toPath), [], FillRule.NonZero, PRECISION))

// The parts of `rings` inside `clip`.
export const intersectRings = (rings: Ring[], clip: Ring[]) =>
  outerRings(intersectD(rings.map(toPath), clip.map(toPath), FillRule.NonZero, PRECISION))

// The parts of `rings` outside `cut`. A part that would hold a hole keeps its outer ring only, so
// cut only along edges or from the outside in.
export const subtractRings = (rings: Ring[], cut: Ring[]) =>
  outerRings(differenceD(rings.map(toPath), cut.map(toPath), FillRule.NonZero, PRECISION))

// The parts of `rings` outside `cut`, with no part holding a hole: where a cut ring would leave a
// hole, the region is first split by a north-south line through that ring. Use it to take rooms
// or a core out of the middle of a floor.
export function subtractSplit(rings: Ring[], cut: Ring[]) {
  const paths = differenceD(rings.map(toPath), cut.map(toPath), FillRule.NonZero, PRECISION)
  const holes = paths.filter((path) => signedArea(path) < -MIN_AREA_M2).map((path) => path.map(({ x }) => x))
  if (!holes.length) return outerRings(paths)
  // The fewest lines that pass through every hole: sweep the holes by their east end.
  const lines: number[] = []
  for (const xs of holes.toSorted((a, b) => Math.max(...a) - Math.max(...b))) {
    const [minX, maxX] = [Math.min(...xs), Math.max(...xs)]
    if (!lines.some((x) => x > minX && x < maxX)) lines.push((minX + maxX) / 2)
  }
  const all = rings.flat()
  const [minY, maxY] = [Math.min(...all.map(([, y]) => y)) - 1, Math.max(...all.map(([, y]) => y)) + 1]
  const edges = [Math.min(...all.map(([x]) => x)) - 1, ...lines.toSorted((a, b) => a - b), Math.max(...all.map(([x]) => x)) + 1]
  return edges.slice(1).flatMap((east, i): Ring[] => {
    const west = edges[i]
    const strip: Ring = [[west, minY], [east, minY], [east, maxY], [west, maxY]]
    return outerRings(differenceD(intersectD(rings.map(toPath), [toPath(strip)], FillRule.NonZero, PRECISION), cut.map(toPath), FillRule.NonZero, PRECISION))
  }).toSorted((a, b) => ringArea(b) - ringArea(a))
}

// Every ring grown by `deltaM`, or shrunk by a negative one, with mitred corners, then united.
export const offsetRings = (rings: Ring[], deltaM: number) =>
  outerRings(inflatePathsD(rings.map(toPath), deltaM, JoinType.Miter, EndType.Polygon, MITER_LIMIT, PRECISION))

// One outline around rooms that stand apart by their walls: grows each by `gapM`, unites them and
// shrinks the union back.
export const closeGaps = (rings: Ring[], gapM: number) => offsetRings(unionRings(offsetRings(rings, gapM)), -gapM)

// The total area of rings that do not overlap, in square metres.
export const areaOf = (rings: Ring[]) => rings.reduce((sum, ring) => sum + ringArea(ring), 0)

// The area two sets of rings share, in square metres.
export const sharedArea = (a: Ring[], b: Ring[]) => areaOf(intersectRings(a, b))

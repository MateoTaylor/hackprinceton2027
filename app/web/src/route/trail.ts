import type { RouteDetail } from '../../../server/src/ops/route/index.ts'

export type ConfidenceBand = 'good' | 'mid' | 'bad'

// The solid score colours of docs/design/design.md, by band.
export const CONFIDENCE_BANDS: Record<ConfidenceBand, string> = { good: '#148A60', mid: '#B07F22', bad: '#B23B33' }

export const confidenceBand = (confidence: number): ConfidenceBand => (confidence >= 0.6 ? 'good' : confidence >= 0.3 ? 'mid' : 'bad')

// Points every `stepM` along the parts of a trail on one storey, as `[x, y]`. A part ends where
// the trail leaves the storey, so a connector is never drawn across the floor.
//   resampleTrail([[0, 0, 0], [10, 0, 0]], 0) // 21 points
export function resampleTrail(trail: RouteDetail['trail'], storeyIndex: number, stepM = 0.5) {
  const points: [number, number][] = []
  trail.forEach(([x, y, storey], i) => {
    if (storey !== storeyIndex) return
    const previous = trail[i - 1]
    if (!previous || previous[2] !== storeyIndex) {
      points.push([x, y])
      return
    }
    const lengthM = Math.hypot(x - previous[0], y - previous[1])
    const steps = Math.max(1, Math.round(lengthM / stepM))
    for (let n = 1; n <= steps; n++) points.push([previous[0] + ((x - previous[0]) * n) / steps, previous[1] + ((y - previous[1]) * n) / steps])
  })
  return points
}

// How long the walk along one storey's trail takes: about 40 m a second, kept between 1.5 and 3 s
// so a short route still reads as a walk and a long one does not drag. A trail has a dot every
// half metre.
export const walkMs = (dotCount: number) => Math.min(3000, Math.max(1500, dotCount * 12.5))

// What a walk along one storey's trail shows at `progress` (0 to 1): how many dots from the
// entrance end, and for each mark whether the walk has reached it. A mark appears with the dot
// nearest to it. At 1 everything shows.
//   walkReveal(dots, marks.map(({ at }) => at), 0.5) // { dots: 40, marks: [true, false] }
export function walkReveal(dots: [number, number][], marksAt: [number, number][], progress: number) {
  const done = progress >= 1
  const shown = done ? dots.length : Math.ceil(dots.length * Math.max(progress, 0))
  const nearest = ([x, y]: [number, number]) => {
    let best = 0
    dots.forEach(([dx, dy], i) => {
      if (Math.hypot(dx - x, dy - y) < Math.hypot(dots[best][0] - x, dots[best][1] - y)) best = i
    })
    return best
  }
  return { dots: shown, marks: marksAt.map((at) => done || nearest(at) < shown) }
}

// A door mark as the stage draws it: its centre in the building frame, how far above the floor it
// floats and its current width on screen in metres. The overlay updates `sizeM` every frame.
export type DoorMark = { door: RouteDetail['doors'][number]; at: [number, number]; liftM: number; sizeM: number }

// The stage's fixed view: the compass bearing it looks along and how far it looks down.
export type View = { azimuthDeg: number; elevationDeg: number }

// The mark under the cursor, for a hover tooltip, or null. `floorAt` is the floor point the cursor
// ray hits. The ray is followed up to each mark's height and the gap measured on screen, so the hit
// zone is the disc the mark is drawn as, at any zoom.
//   markUnder(marks, pick.at, DEFAULT_LOOK)
export function markUnder(marks: DoorMark[], [x, y]: [number, number], { azimuthDeg, elevationDeg }: View) {
  const [bearing, down] = [(azimuthDeg * Math.PI) / 180, (elevationDeg * Math.PI) / 180]
  const [ux, uy] = [Math.sin(bearing), Math.cos(bearing)]
  const hits = marks.map((mark) => {
    const back = mark.liftM / Math.tan(down)
    const [dx, dy] = [mark.at[0] - (x - ux * back), mark.at[1] - (y - uy * back)]
    const along = (dx * ux + dy * uy) * Math.sin(down)
    const across = dx * uy - dy * ux
    return { mark, gapM: Math.hypot(along, across) }
  })
  const near = hits.filter(({ mark, gapM }) => gapM <= mark.sizeM / 2).sort((a, b) => a.gapM - b.gapM)
  return near[0]?.mark.door ?? null
}

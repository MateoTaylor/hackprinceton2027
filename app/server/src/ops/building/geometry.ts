import type { Point, Ring } from '../../model/building.ts'
import { bearingDeg, orientCcw, pointInRing } from '../../model/geo.ts'

const DEG = Math.PI / 180
// How far apart two rings may stand and still meet, in metres. Rooms a scan draws inside their
// walls stand up to this far apart.
const TOUCH_PROBE_M = 0.4
// How finely a wall is walked to find the stretch that runs along another space, in metres.
const RUN_STEP_M = 0.05

const cross = (o: Point, a: Point, b: Point) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

// The convex hull of a set of points, counter-clockwise.
export function convexHull(points: Point[]): Ring {
  const sorted = points.toSorted((a, b) => a[0] - b[0] || a[1] - b[1])
  const half = (list: Point[]) =>
    list.reduce<Point[]>((hull, point) => {
      while (hull.length >= 2 && cross(hull[hull.length - 2], hull[hull.length - 1], point) <= 0) hull.pop()
      hull.push(point)
      return hull
    }, [])
  const lower = half(sorted)
  const upper = half(sorted.toReversed())
  return orientCcw([...lower.slice(0, -1), ...upper.slice(0, -1)])
}

// Turns a point counter-clockwise by `deg` about the origin.
export function rotate([x, y]: Point, deg: number): Point {
  const [cos, sin] = [Math.cos(deg * DEG), Math.sin(deg * DEG)]
  return [x * cos - y * sin, x * sin + y * cos]
}

// The direction of the long side of the smallest rectangle around a ring, counter-clockwise from
// east in degrees, with that rectangle's length and width. A ring with many short edges still gets
// the axis a person would draw.
export function principalAxis(ring: Ring) {
  const hull = convexHull(ring)
  let best = { deg: 0, lengthM: 0, widthM: 0, area: Infinity }
  for (const [i, a] of hull.entries()) {
    const b = hull[(i + 1) % hull.length]
    const deg = Math.atan2(b[1] - a[1], b[0] - a[0]) / DEG
    const turned = hull.map((point) => rotate(point, -deg))
    const [xs, ys] = [turned.map(([x]) => x), turned.map(([, y]) => y)]
    const [dx, dy] = [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)]
    if (dx * dy < best.area) best = dx >= dy ? { deg, lengthM: dx, widthM: dy, area: dx * dy } : { deg: deg + 90, lengthM: dy, widthM: dx, area: dx * dy }
  }
  return { deg: best.deg, lengthM: best.lengthM, widthM: best.widthM }
}

// A rectangle centred on `centre` whose `lengthM` side runs along `axisDeg`.
export function orientedRect(centre: Point, axisDeg: number, lengthM: number, widthM: number): Ring {
  const corners: Point[] = [
    [-lengthM / 2, -widthM / 2],
    [lengthM / 2, -widthM / 2],
    [lengthM / 2, widthM / 2],
    [-lengthM / 2, widthM / 2],
  ]
  return corners.map((corner) => {
    const [x, y] = rotate(corner, axisDeg)
    return [x + centre[0], y + centre[1]]
  })
}

// The point of a ring's edges nearest to `point`, and its distance.
export function nearestOnRing([x, y]: Point, ring: Ring) {
  let best = { at: ring[0], distanceM: Infinity }
  for (const [i, [ax, ay]] of ring.entries()) {
    const [bx, by] = ring[(i + 1) % ring.length]
    const [dx, dy] = [bx - ax, by - ay]
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)))
    const at: Point = [ax + t * dx, ay + t * dy]
    const distanceM = Math.hypot(x - at[0], y - at[1])
    if (distanceM < best.distanceM) best = { at, distanceM }
  }
  return best
}

// Where two spaces meet, as a door point between them, the compass bearing from `a` into `b` and
// the length of wall they share, or null when they stand more than 0.4 m apart. The door sits in
// the middle of the longest straight stretch of `a`'s wall that runs along `b`, and `sharedM` is
// that stretch's length.
//   const door = doorBetween(room.ring, corridor.ring)
export function doorBetween(a: Ring, b: Ring) {
  let best: { from: Point; to: Point; lengthM: number } | null = null
  for (const [i, from] of a.entries()) {
    const to = a[(i + 1) % a.length]
    const edgeM = Math.hypot(to[0] - from[0], to[1] - from[1])
    const steps = Math.max(1, Math.round(edgeM / RUN_STEP_M))
    const along = (t: number): Point => [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t]
    let start = -1
    for (let k = 0; k <= steps + 1; k++) {
      const touches = k <= steps && nearestOnRing(along(k / steps), b).distanceM <= TOUCH_PROBE_M
      if (touches && start < 0) start = k
      if (touches || start < 0) continue
      const lengthM = ((k - 1 - start) / steps) * edgeM
      if (lengthM > (best?.lengthM ?? 0)) best = { from: along(start / steps), to: along((k - 1) / steps), lengthM }
      start = -1
    }
  }
  if (!best) return null
  const onA: Point = [(best.from[0] + best.to[0]) / 2, (best.from[1] + best.to[1]) / 2]
  const onB = nearestOnRing(onA, b).at
  const at: Point = [(onA[0] + onB[0]) / 2, (onA[1] + onB[1]) / 2]
  if (Math.hypot(onB[0] - onA[0], onB[1] - onA[1]) > 0.01) return { at, bearingDeg: bearingDeg(onA, onB), sharedM: best.lengthM }
  // The walls touch, so face along the wall's normal on the side away from `a`.
  const [dx, dy] = [(best.to[0] - best.from[0]) / best.lengthM, (best.to[1] - best.from[1]) / best.lengthM]
  const outward: Point = [onA[0] + dy * 0.05, onA[1] - dx * 0.05]
  const facing = pointInRing(outward, a) ? bearingDeg(onA, [onA[0] - dy, onA[1] + dx]) : bearingDeg(onA, [onA[0] + dy, onA[1] - dx])
  return { at, bearingDeg: facing, sharedM: best.lengthM }
}

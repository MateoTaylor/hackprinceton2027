import type { LngLat } from '../../../shared/api.ts'
import type { Origin, Point, Ring } from './building.ts'

type LatLon = Pick<Origin, 'lat' | 'lon'>

export interface RingBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

const WGS84_A = 6378137
const WGS84_F = 1 / 298.257223563
const WGS84_E2 = WGS84_F * (2 - WGS84_F)
const RAD = Math.PI / 180

function meridianRadius(latRad: number) {
  return (WGS84_A * (1 - WGS84_E2)) / (1 - WGS84_E2 * Math.sin(latRad) ** 2) ** 1.5
}

function parallelRadius(latRad: number) {
  return (WGS84_A * Math.cos(latRad)) / Math.sqrt(1 - WGS84_E2 * Math.sin(latRad) ** 2)
}

// Turns a GeoJSON position into a point of the building frame about `origin`. The projection is
// flat. A point 1 km from the origin lands within 6 cm of the true east-north tangent plane.
//   const ring = orientCcw(footprint.map((position) => toEnu(building.origin, position)))
export function toEnu(origin: LatLon, [lon, lat]: LngLat): Point {
  const midLat = ((origin.lat + lat) / 2) * RAD
  return [(lon - origin.lon) * RAD * parallelRadius(midLat), (lat - origin.lat) * RAD * meridianRadius(origin.lat * RAD)]
}

// The exact inverse of `toEnu` about the same origin, as a GeoJSON position.
export function toLatLon(origin: LatLon, [x, y]: Point): LngLat {
  const lat = origin.lat + y / meridianRadius(origin.lat * RAD) / RAD
  const midLat = ((origin.lat + lat) / 2) * RAD
  return [origin.lon + x / parallelRadius(midLat) / RAD, lat]
}

// The signed area in square metres: positive for a counter-clockwise ring, negative for a
// clockwise one.
export function ringArea(ring: Ring) {
  let twice = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    twice += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1]
  }
  return twice / 2
}

// The centre of mass of a ring. For a concave ring it can fall outside the ring.
export function ringCentroid(ring: Ring): Point {
  let cx = 0
  let cy = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const cross = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1]
    cx += (ring[j][0] + ring[i][0]) * cross
    cy += (ring[j][1] + ring[i][1]) * cross
  }
  const sixArea = 6 * ringArea(ring)
  return [cx / sixArea, cy / sixArea]
}

export function ringBounds(ring: Ring): RingBounds {
  const xs = ring.map(([x]) => x)
  const ys = ring.map(([, y]) => y)
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) }
}

// Returns the ring counter-clockwise without a repeated closing point. Pass every ring from Vexcel,
// Overture or a scan through it before it goes into a building.
export function orientCcw(ring: Ring): Ring {
  const [first, last] = [ring[0], ring.at(-1)]
  const open = last && first[0] === last[0] && first[1] === last[1] ? ring.slice(0, -1) : ring
  return ringArea(open) < 0 ? open.toReversed() : open
}

// Whether the point lies inside the ring, or within `toleranceM` of its edge. With no tolerance a
// point exactly on an edge may land either way.
export function pointInRing([x, y]: Point, ring: Ring, toleranceM = 0) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside || (toleranceM > 0 && distanceToRingM([x, y], ring) <= toleranceM)
}

function distanceToRingM([x, y]: Point, ring: Ring) {
  let nearest = Infinity
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[j]
    const [dx, dy] = [ring[i][0] - ax, ring[i][1] - ay]
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)))
    nearest = Math.min(nearest, Math.hypot(x - ax - t * dx, y - ay - t * dy))
  }
  return nearest
}

// The compass direction from one point to another, clockwise from north, in 0 up to 360.
export function bearingDeg([fromX, fromY]: Point, [toX, toY]: Point) {
  return (Math.atan2(toX - fromX, toY - fromY) / RAD + 360) % 360
}

export function distanceM([ax, ay]: Point, [bx, by]: Point) {
  return Math.hypot(bx - ax, by - ay)
}

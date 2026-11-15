import type { LngLat, ObliquePose } from '../../shared/api'

// The camera geometry of the photo view, kept free of MapLibre so it can be tested in Node.

export type Padding = { top: number; bottom: number; left: number; right: number }

// One photo as a place the camera can rest: looking along `bearing` at `center`, tilted to `pitch`,
// at `fit`, the zoom where the photo fills the free part of the map.
export type Stop = { bearing: number; pitch: number; fit: number; center: LngLat }

export type Camera = { center: LngLat; zoom: number; bearing: number }

// Whether the camera belongs to the photos or to the flat map. A camera that comes to rest on the
// flat map stays flat until the user zooms in toward the property, even when a new chat inset or
// heading would put it inside the band of the photos' new fit.
export type Stance = 'photo' | 'flat'

const EARTH_CIRCUMFERENCE = 40_075_016.686
const WORLD_PX = 512
const M_PER_DEG = 111_320

// The property shows at most twice the photo's native size, so a small parcel never turns to mush.
const MAX_SCALE = 2

// At rest the photo reaches 2^HEADROOM past every edge of the map, and it shows only while it reaches
// past them, fully once by 2^GATE. Any edge of it in view would show against the tiles around it,
// which it never lines up with. fitZoom's estimate of the reach is off by up to about 0.1 zoom
// levels on a pitched photo, so GATE sits well below HEADROOM for the photo to show fully at rest.
const HEADROOM = 0.3
const GATE = 0.15

// Below fit - BAND the map is flat and top-down. The camera tilts to the photo's pitch by
// fit - REVEAL, and the photo takes over by fit. A camera left within SNAP of fit is resting on it.
const BAND = 1.6
const REVEAL = 0.4
const SNAP = 0.1

// Past this much turn away from a photo's heading it has faded out, because the drape stops
// lining up with the buildings it shows.
const TURN_FADE = [6, 24] as const

// Zooming in past fit + LOCK still counts as resting on the photo, so a stray wheel tick snaps back.
const LOCK = 0.15

export const smoothstep = (edge0: number, edge1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

// The signed turn in degrees, in (-180, 180], that takes heading `from` to heading `to`.
export const shortestTurn = (from: number, to: number) => {
  const d = (((to - from) % 360) + 360) % 360
  return d > 180 ? d - 360 : d
}

// The zoom at which a photo rests: its focus box fills the map inside `padding`, unless the photo
// would then leave part of the map bare. Then it zooms in until the photo covers the whole map with
// HEADROOM to spare. Seen from the aircraft's pose the draped photo looks much as the camera took
// it, and at the centre of a pitched view MapLibre keeps the unpitched horizontal scale, so the
// photo's own pixels give both scales.
export function fitZoom(pose: Pick<ObliquePose, 'width' | 'height' | 'metresPerPixel' | 'focus'>, size: { width: number; height: number }, padding: Padding) {
  const { focus } = pose
  const [freeWidth, freeHeight] = [size.width - padding.left - padding.right, size.height - padding.top - padding.bottom]
  const fill = Math.min(freeWidth / focus.width, freeHeight / focus.height, MAX_SCALE)
  const [ox, oy] = [padding.left + freeWidth / 2, padding.top + freeHeight / 2]
  const [fx, fy] = [focus.x + focus.width / 2, focus.y + focus.height / 2]
  const cover = 2 ** HEADROOM * Math.max(ox / fx, (size.width - ox) / (pose.width - fx), oy / fy, (size.height - oy) / (pose.height - fy))
  const metresPerScreenPx = pose.metresPerPixel / Math.max(fill, cover)
  return Math.log2((EARTH_CIRCUMFERENCE * Math.cos((focus.center[1] * Math.PI) / 180)) / (WORLD_PX * metresPerScreenPx))
}

// How far the camera has tilted from the flat map toward a photo that rests at `fit`, from 0 to 1.
export const tiltMix = (zoom: number, fit: number) => smoothstep(fit - BAND, fit - REVEAL, zoom)

// How far the photo has taken over from the flat map at `zoom`, from 0 to 1.
export const photoMix = (zoom: number, fit: number) => smoothstep(fit - REVEAL, fit, zoom)

// The highest zoom at which the map is still flat and top-down, below a photo that fits at `fit`.
export const flatZoom = (fit: number) => fit - BAND

// Whether the map is flat at `zoom`. A camera eased out to flatZoom can land a rounding error above it.
const isFlat = (zoom: number, fit: number) => zoom <= flatZoom(fit) + 1e-6

type Point = [x: number, y: number]

// How many zoom levels the camera can zoom out about `origin` before an edge of `quad`, a convex
// photo outline in screen pixels, enters the screen of `size`. Negative once an edge is in view,
// and -Infinity when `origin` is off the photo.
export function headroom(quad: readonly Point[], origin: Point, size: { width: number; height: number }) {
  const [ox, oy] = origin
  const turn = Math.sign(quad.reduce((sum, [x, y], i) => sum + x * quad[(i + 1) % quad.length][1] - quad[(i + 1) % quad.length][0] * y, 0))
  const corners: Point[] = [[0, 0], [size.width, 0], [size.width, size.height], [0, size.height]]
  let reach = Infinity
  for (const [i, [ax, ay]] of quad.entries()) {
    const [bx, by] = quad[(i + 1) % quad.length]
    // Outward normal of edge a→b, and how far inside it the origin sits.
    const [nx, ny] = [turn * (by - ay), -turn * (bx - ax)]
    const inside = nx * (ax - ox) + ny * (ay - oy)
    if (!(inside > 0)) return -Infinity
    for (const [cx, cy] of corners) {
      const out = nx * (cx - ox) + ny * (cy - oy)
      if (out > 0) reach = Math.min(reach, inside / out)
    }
  }
  return Math.log2(reach)
}

// How visible a photo is with `headroom` to spare, from 0 to 1.
export const coverMix = (headroom: number) => smoothstep(0, GATE, headroom)

// How visible a photo taken looking along `photoBearing` is from a camera looking along `bearing`.
export const turnFade = (bearing: number, photoBearing: number) => 1 - smoothstep(TURN_FADE[0], TURN_FADE[1], Math.abs(shortestTurn(bearing, photoBearing)))

export function nearest(bearing: number, stops: readonly Stop[]) {
  return stops.reduce((best, s) => (Math.abs(shortestTurn(bearing, s.bearing)) < Math.abs(shortestTurn(bearing, best.bearing)) ? s : best))
}

// The pitch and fit for a camera looking along `bearing`, blended between the two photos either side
// of it so a drag between them tilts smoothly.
export function poseAt(bearing: number, stops: readonly Stop[]) {
  const turns = stops.map((stop) => ({ stop, d: shortestTurn(bearing, stop.bearing) })).toSorted((a, b) => a.d - b.d)
  const behind = turns.findLast((t) => t.d <= 0) ?? { ...turns[turns.length - 1], d: turns[turns.length - 1].d - 360 }
  const ahead = turns.find((t) => t.d >= 0) ?? { ...turns[0], d: turns[0].d + 360 }
  const span = ahead.d - behind.d
  const t = span === 0 ? 0 : -behind.d / span
  const lerp = (a: number, b: number) => a + (b - a) * t
  return { pitch: lerp(behind.stop.pitch, ahead.stop.pitch), fit: lerp(behind.stop.fit, ahead.stop.fit) }
}

// The pitch the camera must have at `zoom` and `bearing`: flat over the map, the photo's own tilt
// once the photo has taken over.
export function pitchFor(zoom: number, bearing: number, stops: readonly Stop[], stance: Stance) {
  if (stance === 'flat') return 0
  const { pitch, fit } = poseAt(bearing, stops)
  return pitch * tiltMix(zoom, fit)
}

export const fullPose = (stop: Stop) => ({ center: stop.center, zoom: stop.fit, bearing: stop.bearing })

const metresBetween = (a: LngLat, b: LngLat) =>
  Math.hypot((a[0] - b[0]) * M_PER_DEG * Math.cos((a[1] * Math.PI) / 180), (a[1] - b[1]) * M_PER_DEG)

// Where the camera should settle after the user stops moving it, or null to stay put. Inside the
// band it settles in the direction the user was zooming: out to the flat map, in to the nearest photo.
// Resting on a photo puts it back square on that photo. Zoomed in past it, only the heading snaps.
// Settling twice changes nothing.
export function restPose(camera: Camera, stops: readonly Stop[], zoomingOut: boolean, stance: Stance): Camera | null {
  if (stops.length === 0 || stance === 'flat') return null
  const { fit } = poseAt(camera.bearing, stops)
  if (isFlat(camera.zoom, fit)) return null
  const stop = nearest(camera.bearing, stops)
  if (camera.zoom < fit - SNAP) return zoomingOut ? { center: camera.center, zoom: flatZoom(fit), bearing: camera.bearing } : fullPose(stop)
  const squared = Math.abs(shortestTurn(camera.bearing, stop.bearing)) < 0.5
  if (camera.zoom <= stop.fit + LOCK) {
    const resting = squared && Math.abs(camera.zoom - stop.fit) < 0.02 && metresBetween(camera.center, stop.center) < 0.5
    return resting ? null : fullPose(stop)
  }
  return squared ? null : { ...camera, bearing: stop.bearing }
}

// Whether the camera sits close enough to a photo that panning should be off: anywhere in the band
// above the flat map, up to a little past the photo.
export function locked(zoom: number, bearing: number, stops: readonly Stop[], stance: Stance) {
  if (stops.length === 0 || stance === 'flat') return false
  const { fit } = poseAt(bearing, stops)
  return !isFlat(zoom, fit) && zoom <= fit + LOCK
}

// The stance of a camera that has come to rest: flat once it rests on the flat map, and otherwise
// whatever it was.
export function stanceAt(stance: Stance, camera: Camera, stops: readonly Stop[]): Stance {
  return stops.length && isFlat(camera.zoom, poseAt(camera.bearing, stops).fit) ? 'flat' : stance
}

// Where a released orbit drag comes to rest: the photo nearest to where its momentum would carry it.
// `velocity` is in degrees per second.
export function orbitRest(bearing: number, velocity: number, stops: readonly Stop[]) {
  const coast = Math.max(-50, Math.min(50, velocity * 0.18))
  const stop = nearest(bearing + coast, stops)
  return { stop, duration: turnDuration(bearing, stop.bearing) }
}

// How long a turn from heading `from` to heading `to` takes, in milliseconds.
export const turnDuration = (from: number, to: number) => Math.max(200, Math.min(700, 120 + 6 * Math.abs(shortestTurn(from, to))))

// The photo after or before heading `from` going clockwise, for keyboard stepping. A photo facing
// `from` itself is a whole turn away.
export function step(from: number, by: 1 | -1, stops: readonly Stop[]) {
  const ahead = (s: Stop) => (by * shortestTurn(from, s.bearing) + 360) % 360 || 360
  return stops.reduce((best, s) => (ahead(s) < ahead(best) ? s : best))
}

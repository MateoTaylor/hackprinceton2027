import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { LngLat } from '../../shared/api'
import { coverMix, fitZoom, flatZoom, headroom, locked, orbitRest, photoMix, pitchFor, poseAt, restPose, shortestTurn, stanceAt, step, tiltMix, type Stop } from './stance.ts'

// Poses like the real north, east and south photos of commercial-1254240: a photo about 2.2 times
// the property's box each way, with the box near its middle.
const photo = (center: LngLat, metresPerPixel: number, bearing: number, pitch: number) => ({
  width: 2750, height: 2200, metresPerPixel, bearing, pitch, focus: { center, x: 755, y: 575, width: 1240, height: 1050 },
})
const north = photo([-118.250105, 34.034083], 0.06709, 0.308, 40.8)
const east = photo([-118.250032, 34.034001], 0.07074, 89.31, 45.17)
const south = photo([-118.250108, 34.033938], 0.06541, -177.98, 41.5)

const size = { width: 1440, height: 900 }
const padding = { top: 80, bottom: 80, left: 376, right: 80 }
const stopOf = (p: typeof north): Stop => ({ bearing: p.bearing, pitch: p.pitch, center: p.focus.center, fit: fitZoom(p, size, padding) })

// Screen pixels per photo pixel at `zoom`, by the same scale rule fitZoom uses.
const scaleAt = (p: typeof north, zoom: number) => (2 ** zoom * 512 * p.metresPerPixel) / (40_075_016.686 * Math.cos((p.focus.center[1] * Math.PI) / 180))

// The photo's outline on a flat screen, with its focus centre on the free area's centre.
function screenQuad(p: typeof north, zoom: number): [number, number][] {
  const k = scaleAt(p, zoom)
  const [ox, oy] = [padding.left + (size.width - padding.left - padding.right) / 2, padding.top + (size.height - padding.top - padding.bottom) / 2]
  const [fx, fy] = [p.focus.x + p.focus.width / 2, p.focus.y + p.focus.height / 2]
  return [[0, 0], [p.width, 0], [p.width, p.height], [0, p.height]].map(([x, y]) => [ox + (x - fx) * k, oy + (y - fy) * k])
}
const stops = [north, east, south].map(stopOf)
const [N, E, S] = stops

test('shortestTurn takes the short way round', () => {
  assert.equal(shortestTurn(350, 10), 20)
  assert.equal(shortestTurn(10, 350), -20)
  assert.equal(shortestTurn(-170, 100), -90)
})

test('fitZoom fills the free area with the focus box, one zoom level per doubling of it', () => {
  const wide = { ...north, width: 40_000, height: 40_000, focus: { ...north.focus, x: 20_000, y: 20_000 } }
  const twice = { width: 2 * size.width - padding.left - padding.right, height: 2 * size.height - padding.top - padding.bottom }
  assert.ok(Math.abs(fitZoom(wide, twice, padding) - fitZoom(wide, size, padding) - 1) < 1e-9)
  const tiny = { ...wide, focus: { ...wide.focus, width: 100, height: 100 } }
  assert.equal(fitZoom(tiny, size, padding), fitZoom({ ...tiny, focus: { ...tiny.focus, width: 50, height: 50 } }, size, padding), 'a small box stops growing at twice its size')
})

test('fitZoom zooms in until the photo covers the whole map with headroom to spare', () => {
  const tight = { ...north, width: 1240, height: 1050, focus: { ...north.focus, x: 0, y: 0 } }
  const fit = fitZoom(tight, size, padding)
  assert.ok(Math.abs(headroom(screenQuad(tight, fit), [size.width / 2, size.height / 2], size) - 0.3) < 0.2)
  const origin: [number, number] = [padding.left + (size.width - padding.left - padding.right) / 2, padding.top + (size.height - padding.top - padding.bottom) / 2]
  assert.ok(Math.abs(headroom(screenQuad(tight, fit), origin, size) - 0.3) < 1e-9, 'exactly the headroom about the free centre')
  assert.ok(headroom(screenQuad(north, N.fit), origin, size) >= 0.3 - 1e-9 && coverMix(headroom(screenQuad(north, N.fit), origin, size)) === 1)
})

test('headroom is how far the camera can zoom out before a photo edge shows', () => {
  const square = (half: number): [number, number][] => [[50 - half, 50 - half], [50 + half, 50 - half], [50 + half, 50 + half], [50 - half, 50 + half]]
  const box = { width: 100, height: 100 }
  assert.ok(Math.abs(headroom(square(100), [50, 50], box) - 1) < 1e-9)
  assert.ok(Math.abs(headroom(square(100).toReversed(), [50, 50], box) - 1) < 1e-9, 'either winding')
  assert.ok(headroom(square(40), [50, 50], box) < 0, 'an edge already in view')
  assert.equal(headroom(square(40), [95, 50], box), -Infinity, 'origin off the photo')
  assert.equal(coverMix(-0.1), 0)
})

test('the camera tilts over the map before the photo shows, and the photo shows only near rest', () => {
  assert.equal(pitchFor(flatZoom(N.fit), N.bearing, stops, 'photo'), 0)
  assert.ok(Math.abs(pitchFor(N.fit - 0.4, N.bearing, stops, 'photo') - north.pitch) < 1e-9)
  assert.equal(photoMix(N.fit - 0.4, N.fit), 0)
  assert.equal(photoMix(N.fit, N.fit), 1)
  assert.ok(tiltMix(N.fit - 1, N.fit) > 0 && tiltMix(N.fit - 1, N.fit) < 1)
})

test('poseAt blends between the photos either side, across a missing side too', () => {
  const half = poseAt((N.bearing + E.bearing) / 2, stops)
  assert.ok(Math.abs(half.pitch - (north.pitch + east.pitch) / 2) < 1e-9)
  const west = poseAt(-90, stops)
  assert.ok(west.pitch > Math.min(north.pitch, south.pitch) && west.pitch < Math.max(north.pitch, south.pitch), 'west blends north and south')
  assert.equal(poseAt(123, [N]).pitch, north.pitch)
})

test('restPose settles in the zoom direction and settling twice changes nothing', () => {
  const inBand = { center: N.center, zoom: N.fit - 1, bearing: 3 }
  const out = restPose(inBand, stops, true, 'photo')
  assert.ok(out && pitchFor(out.zoom, out.bearing, stops, 'photo') === 0, 'zooming out lands flat')
  assert.deepEqual(restPose(inBand, stops, false, 'photo'), { center: N.center, zoom: N.fit, bearing: N.bearing })
  assert.deepEqual(restPose({ ...inBand, zoom: N.fit - 0.05 }, stops, true, 'photo'), { center: N.center, zoom: N.fit, bearing: N.bearing }, 'a camera just short of rest is resting')

  const cameras = [
    inBand,
    { center: E.center, zoom: E.fit + 0.1, bearing: 70 },
    { center: [-118.2495, 34.0345] as LngLat, zoom: S.fit + 1, bearing: 160 },
    { center: N.center, zoom: N.fit - 4, bearing: 40 },
  ]
  for (const zoomingOut of [true, false]) {
    for (const camera of cameras) {
      const first = restPose(camera, stops, zoomingOut, 'photo') ?? camera
      assert.equal(restPose(first, stops, zoomingOut, 'photo'), null, `settled from ${JSON.stringify(camera)}`)
    }
  }
  assert.deepEqual(restPose({ center: [-118.2495, 34.0345], zoom: S.fit + 1, bearing: 160 }, stops, false, 'photo'), { center: [-118.2495, 34.0345], zoom: S.fit + 1, bearing: S.bearing }, 'zoomed in past the photo only the heading snaps')
})

test('an orbit release settles on the nearest photo, carried on by momentum, all the way round', () => {
  const W = stopOf(photo([-118.250180, 34.034010], 0.0688, -91.2, 43.0))
  const all = [N, E, S, W]
  assert.equal(orbitRest(-80, 0, all).stop, W)
  assert.equal(orbitRest(30, 0, all).stop, N)
  assert.equal(orbitRest(30, 300, all).stop, E, 'a fast flick carries on to east')
  assert.equal(orbitRest(-160 - 720, 0, all).stop, S, 'two full turns past south still rests on south')
  assert.equal(step(W.bearing, 1, all), N)
  assert.equal(step(N.bearing, -1, all), W)
  assert.equal(step(N.bearing, 1, all), E)
  assert.deepEqual(step(N.bearing, 1, all.map((s) => ({ ...s, fit: s.fit + 0.5 }))), { ...E, fit: E.fit + 0.5 }, 'stops refitted to a new chat inset still step from the old aim')
})

test('panning is off only in the band above the flat map and just past the photo', () => {
  const at = (zoom: number) => locked(zoom, N.bearing, stops, 'photo')
  assert.equal(at(flatZoom(N.fit) - 3), false, 'zoomed out to the city the map pans')
  assert.equal(at(flatZoom(N.fit)), false, 'settled out to the flat map it pans')
  assert.equal(at(flatZoom(N.fit) + 0.2), true)
  assert.equal(at(N.fit), true)
  assert.equal(at(N.fit + 0.5), false, 'zoomed well past the photo it pans')
})

// The stops as fitted with the chat open, which covers 420 px of the map's right side.
const chatStops = [north, east, south].map((p): Stop => ({ ...stopOf(p), fit: fitZoom(p, size, { ...padding, right: padding.right + 420 }) }))

test('a camera settled out to the flat map stays flat when the chat opens', () => {
  const out = restPose({ center: N.center, zoom: N.fit - 1, bearing: N.bearing }, stops, true, 'photo')
  assert.ok(out)
  const stance = stanceAt('photo', out, stops)
  assert.equal(stance, 'flat')
  assert.ok(locked(out.zoom, out.bearing, chatStops, 'photo'), 'judged against the new fit it would sit in the band')
  assert.equal(stanceAt(stance, out, chatStops), 'flat')
  assert.equal(locked(out.zoom, out.bearing, chatStops, stance), false, 'so it still pans')
  assert.equal(pitchFor(out.zoom, out.bearing, chatStops, stance), 0)
  assert.equal(restPose(out, chatStops, false, stance), null)
})

test('a camera settled out to the flat map stays flat when the compass turns it north', () => {
  // North and south photos that fit half a level lower than east, so facing north the band sits lower.
  const shifted = [{ ...N, fit: E.fit - 0.5 }, E, { ...S, fit: E.fit - 0.5 }]
  const out = restPose({ center: N.center, zoom: N.fit - 1, bearing: E.bearing }, shifted, true, 'photo')
  assert.ok(out)
  const north = { ...out, bearing: 0 }
  assert.ok(locked(north.zoom, 0, shifted, 'photo'), 'judged against the north fit it would sit in the band')
  const stance = stanceAt(stanceAt('photo', out, shifted), north, shifted)
  assert.equal(stance, 'flat')
  assert.equal(locked(north.zoom, 0, shifted, stance), false)
  assert.equal(pitchFor(north.zoom, 0, shifted, stance), 0)
})

test('a camera resting anywhere above the flat map keeps its stance', () => {
  for (const zoom of [N.fit - 1, N.fit, N.fit + 2]) assert.equal(stanceAt('photo', { center: N.center, zoom, bearing: N.bearing }, stops), 'photo')
  assert.equal(stanceAt('flat', { center: N.center, zoom: N.fit, bearing: N.bearing }, stops), 'flat', 'only a zoom in toward the pin leaves flat')
})

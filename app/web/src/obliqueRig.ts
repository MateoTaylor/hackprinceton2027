import type * as maplibregl from 'maplibre-gl'
import type { LngLat, ObliquePose } from '../../shared/api'
import type { ObliqueView, Obliques } from './obliques'
import {
  coverMix,
  fitZoom,
  flatZoom,
  headroom,
  fullPose,
  locked,
  nearest,
  orbitRest,
  photoMix,
  pitchFor,
  poseAt,
  restPose,
  smoothstep,
  stanceAt,
  step,
  turnDuration,
  turnFade,
  type Stance,
  type Stop,
} from './stance'

export type Subject = { id: string; lngLat: LngLat }

export type Rig = ReturnType<typeof attachObliqueRig>

type Photo = { view: ObliqueView; stop: Stop; layer: string; shownAt: number }

type StopPose = Pick<ObliquePose, 'width' | 'height' | 'metresPerPixel' | 'focus' | 'bearing' | 'pitch'>

// A narrow field of view makes the map's perspective match the aircraft's long lens.
const FOV = 4
const FLIGHT = 2200
const RAMP = 500
const FADE = 300
const SETTLE = 450
const SLOP = 4
const DEG_PER_PX = 0.3
const VELOCITY_WINDOW = 80
const BRIGHTNESS = 0.88

// A typical Vexcel photo facing north, so the approach can aim where the photo will sit before it
// arrives. Its focus centre is replaced by the property's own point.
const TYPICAL: StopPose = { width: 2420, height: 1780, metresPerPixel: 0.067, bearing: 0, pitch: 42, focus: { center: [0, 0], x: 590, y: 365, width: 1240, height: 1050 } }

const easeOut = (t: number) => 1 - (1 - t) ** 3
const sameStop = (a: Stop, b: Stop) => a.bearing === b.bearing && a.pitch === b.pitch && a.fit === b.fit && a.center[0] === b.center[0] && a.center[1] === b.center[1]
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')

// Drives the map camera and the draped photos for the selected property. The pitch is never animated
// directly: a camera hook derives it from zoom and bearing on every frame, so flights, wheel zooms
// and orbit drags all tilt the same way. The user's own moves are the ones that carry an
// `originalEvent`. Rig moves carry `{ rig }` instead, and MapLibre's own resize carries neither.
export function attachObliqueRig(map: maplibregl.Map) {
  let input: { subject: Subject | null; obliques: Obliques; chatInset: number } = { subject: null, obliques: { status: 'loading' }, chatInset: 0 }
  let photos: Photo[] = []
  let stops: Stop[] = []
  // A photo still fading out keeps its layer while the same photo fades back in, so each layer gets its own id.
  let leaving: { layer: string; quad: ObliquePose['quad']; from: number; at: number }[] = []
  let layerSeq = 0
  let ramp: { from: number; at: number } | null = null
  let flight: { start: number; end: number } | null = null
  let aim: number | null = null
  let brightness = BRIGHTNESS
  let userMoved = false
  let shown = false
  let zoomingOut = false
  let stance: Stance = 'photo'
  let settlingOut = false
  let lastZoom = map.getZoom()
  let isLocked = false
  let turnable = false
  let endOrbit: ((at?: number) => void) | null = null
  let frame = 0
  const opacity = new Map<string, number>()
  const container = map.getCanvasContainer()

  // Every stop is fitted inside this padding, so every camera move the rig makes carries it. A move
  // without it keeps whatever padding an interrupted flight had reached.
  const padding = () => ({ top: 80, bottom: 80, left: 376, right: 80 + input.chatInset })
  const stopOf = (pose: StopPose): Stop => ({
    bearing: pose.bearing,
    pitch: pose.pitch,
    center: pose.focus.center,
    fit: fitZoom(pose, { width: map.getContainer().clientWidth, height: map.getContainer().clientHeight }, padding()),
  })
  const photoStops = () => photos.map((p) => p.stop)
  // Where the camera can rest now: on the photos, or while the first one loads on its pose once its
  // headers arrive, and before that on a typical photo predicted at the pin, so a flight that starts
  // before any photo still has somewhere to go.
  const currentStops = () => {
    const { subject, obliques } = input
    if (photos.length) return photoStops()
    if (!subject || obliques.status !== 'loading') return []
    return [stopOf(obliques.first ?? { ...TYPICAL, focus: { ...TYPICAL.focus, center: subject.lngLat } })]
  }
  const mixNow = () => (photos.length && stance === 'photo' ? photoMix(map.getZoom(), poseAt(map.getBearing(), photoStops()).fit) : 0)
  // Only a property photographed from all four sides turns, so any turn the user makes lands on a
  // photo, and only once its photo shows, so a drag on the flat map never dives into one.
  const canTurn = () => photos.length === 4 && mixNow() > 0.5
  const camera = () => {
    const { lng, lat } = map.getCenter()
    return { center: [lng, lat] satisfies LngLat, zoom: map.getZoom(), bearing: map.getBearing() }
  }

  map.setVerticalFieldOfView(FOV)
  // With panning off on a photo MapLibre leaves the browser free to claim a one-finger drag as a
  // page scroll, which would cancel the orbit.
  for (const el of [container, map.getCanvas()]) el.style.touchAction = 'none'
  map.dragRotate.disable()
  map.touchPitch.disable()
  map.touchZoomRotate.disableRotation()
  map.keyboard.disableRotation()
  map.setTransformCameraUpdate(({ zoom, bearing }) => {
    const target = stops.length ? pitchFor(zoom, bearing, stops, stance) : 0
    if (!ramp) return { pitch: target }
    const t = (performance.now() - ramp.at) / RAMP
    if (t >= 1) {
      ramp = null
      return { pitch: target }
    }
    return { pitch: ramp.from + (target - ramp.from) * smoothstep(0, 1, t) }
  })

  // Eases the pitch from wherever it is to what the pitch rule now says, after the rule's inputs jump.
  function startRamp() {
    ramp = reducedMotion.matches ? null : { from: map.getPitch(), at: performance.now() }
    kick()
  }

  // While a ramp or a fade runs with the camera still, a no-op jump re-runs the pitch hook and repaints.
  function kick() {
    if (!frame) frame = requestAnimationFrame(tick)
  }

  function tick() {
    frame = 0
    if (!map.isMoving()) map.jumpTo({}, { rig: 'tick' })
    const now = performance.now()
    if (ramp || leaving.length || photos.some((p) => now - p.shownAt < FADE)) kick()
  }

  // Small changes are skipped to save repaints, but zero is always written so a photo meant to be
  // hidden never lingers faintly.
  function setOpacity(layer: string, value: number) {
    const old = opacity.get(layer)
    if (old === value || (value > 0 && old !== undefined && Math.abs(old - value) < 0.002)) return
    opacity.set(layer, value)
    map.setPaintProperty(layer, 'raster-opacity', value)
  }

  function addPhoto(view: ObliqueView): Photo {
    const layer = `oblique-${view.direction}-${layerSeq++}`
    map.addSource(layer, { type: 'image', coordinates: view.quad })
    map.getSource<maplibregl.ImageSource>(layer)?.setWarp('perspective').updateImage({ image: view.image })
    map.addLayer({ id: layer, type: 'raster', source: layer, paint: { 'raster-opacity': 0, 'raster-fade-duration': 0 } })
    opacity.set(layer, 0)
    return { view, stop: stopOf(view), layer, shownAt: performance.now() }
  }

  function dropLayer(layer: string) {
    opacity.delete(layer)
    if (map.getLayer(layer)) map.removeLayer(layer)
    if (map.getSource(layer)) map.removeSource(layer)
  }

  // How much of a photo may show from where the camera is: none once any edge of it would be in view.
  function cover(quad: ObliquePose['quad']) {
    const { x, y } = map.project(map.getCenter())
    const size = { width: map.getContainer().clientWidth, height: map.getContainer().clientHeight }
    const screen = quad.map((c) => map.project(c)).map((q): [number, number] => [q.x, q.y])
    return coverMix(headroom(screen, [x, y], size))
  }

  function paint() {
    const now = performance.now()
    const bearing = map.getBearing()
    const mix = mixNow()
    // A photo fades in fast and finishes gently, so it reads as arriving the moment it decodes.
    const fade = (since: number) => (reducedMotion.matches ? 1 : easeOut(Math.min(1, since / FADE)))
    for (const p of photos) {
      const shown = mix * turnFade(bearing, p.stop.bearing) * fade(now - p.shownAt)
      setOpacity(p.layer, shown > 0 ? shown * cover(p.view.quad) : 0)
    }
    leaving = leaving.filter((l) => {
      const t = (now - l.at) / FADE
      if (t >= 1 || reducedMotion.matches) {
        dropLayer(l.layer)
        return false
      }
      setOpacity(l.layer, l.from * (1 - t) * cover(l.quad))
      return true
    })
    const dim = Math.round((BRIGHTNESS - 0.3 * mix) * 500) / 500
    if (dim !== brightness) {
      brightness = dim
      map.setPaintProperty('vexcel', 'raster-brightness-max', dim)
    }

    if (!shown && photos.some((p) => (opacity.get(p.layer) ?? 0) >= 0.95)) {
      shown = true
      performance.mark('oblique:shown', { detail: input.subject?.id })
      performance.measure('time-to-photo', 'oblique:select', 'oblique:shown')
    }

    const lock = photos.length > 0 && locked(map.getZoom(), bearing, photoStops(), stance)
    if (lock !== isLocked) {
      isLocked = lock
      if (lock) map.dragPan.disable()
      else map.dragPan.enable()
    }
    if (canTurn() !== turnable) {
      turnable = canTurn()
      if (turnable) {
        map.touchZoomRotate.enableRotation()
        // enableRotation() turns about the fingers; re-enabling turns about the pin.
        map.touchZoomRotate.enable({ around: 'center' })
      } else map.touchZoomRotate.disableRotation()
    }
  }

  // After the user stops moving the camera, it settles in the band in the way they were zooming,
  // or back square on the nearest photo.
  function settle() {
    if (!photos.length) return
    const rest = restPose(camera(), photoStops(), zoomingOut, stance)
    if (!rest) return
    map.easeTo({ ...rest, padding: padding(), duration: SETTLE }, { rig: 'settle' })
    settlingOut = stanceAt('photo', rest, photoStops()) === 'flat'
  }

  const inFlight = () => flight !== null && performance.now() < flight.end && map.isMoving()

  // Re-aims the approach at stops[0] in the time it has left, after the stops move under it.
  function chase() {
    if (!flight || !stops[0]) return
    const now = performance.now()
    const early = now - flight.start < 300
    const duration = Math.max(700, flight.end - now)
    flight = { start: flight.start, end: now + duration }
    map.flyTo({ ...fullPose(stops[0]), padding: padding(), duration, ...(early ? {} : { easing: easeOut }) }, { rig: 'select' })
  }

  // After the stops are refitted to a new chat inset or map size, moves the camera to the same place
  // relative to them over `duration`: a flight keeps flying, a settle out keeps heading for the flat
  // map, and a camera that was or now would be locked rests on its photo. Returns false, moving
  // nothing, for a camera that is free to stay where it is: flat, or zoomed in past the photo.
  function refit(wasLocked: boolean, duration: number) {
    const bearing = map.getBearing()
    if (inFlight()) chase()
    else if (settlingOut && map.isMoving()) {
      map.easeTo({ ...camera(), zoom: flatZoom(poseAt(bearing, photoStops()).fit), padding: padding(), duration }, { rig: 'settle' })
      settlingOut = true
    } else if (wasLocked || locked(map.getZoom(), bearing, photoStops(), stance)) {
      map.easeTo({ ...fullPose(nearest(bearing, photoStops())), padding: padding(), duration }, { rig: 'refit' })
    } else return false
    return true
  }

  // Whether the property's pin sits in the free part of the map, outside the sidebar and the chat.
  function pinInView() {
    if (!input.subject) return false
    const { x, y } = map.project(input.subject.lngLat)
    const { top, bottom, left, right } = padding()
    const { clientWidth: width, clientHeight: height } = map.getContainer()
    return x >= left && x <= width - right && y >= top && y <= height - bottom
  }

  // Drops photos still fading out. A hidden tab never paints, so they would outlive their bitmaps.
  function dropLeaving() {
    for (const l of leaving) dropLayer(l.layer)
    leaving = []
  }
  const onVisibility = () => {
    if (document.hidden) dropLeaving()
  }
  document.addEventListener('visibilitychange', onVisibility)

  function turnTo(stop: Stop, duration: number) {
    aim = stop.bearing
    map.easeTo({ ...fullPose(stop), padding: padding(), duration }, { rig: 'turn' })
  }

  map.on('move', paint)
  if (import.meta.env.DEV) map.on('render', () => checkSeams(map, [...photos.map((p) => ({ layer: p.layer, quad: p.view.quad })), ...leaving], opacity))
  map.on('movestart', (e) => {
    if (!('originalEvent' in e)) return
    userMoved = true
    flight = null
  })
  // Zooming in toward the property's pin takes a flat camera back to the photos. Zooming in
  // anywhere else stays a plain map zoom.
  map.on('zoom', (e) => {
    const zoom = map.getZoom()
    if ('originalEvent' in e) {
      zoomingOut = zoom < lastZoom
      if (stance === 'flat' && zoom > lastZoom && pinInView()) {
        stance = 'photo'
        const now = performance.now()
        photos = photos.map((p) => ({ ...p, shownAt: now }))
        startRamp()
      }
    }
    lastZoom = zoom
  })
  map.on('moveend', (e) => {
    settlingOut = false
    if ('rig' in e && e.rig === 'select') return
    stance = stanceAt(stance, camera(), photoStops())
    if ('originalEvent' in e) settle()
  })
  map.on('resize', () => {
    const wasLocked = isLocked
    photos = photos.map((p) => ({ ...p, stop: stopOf(p.view) }))
    stops = currentStops()
    if (input.subject) refit(wasLocked, map.isMoving() ? 300 : 0)
  })

  container.addEventListener(
    'keydown',
    (e) => {
      if ((e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || !canTurn()) return
      e.preventDefault()
      e.stopPropagation()
      const from = aim !== null && map.isMoving() ? aim : nearest(map.getBearing(), photoStops()).bearing
      const to = step(from, e.key === 'ArrowRight' ? 1 : -1, photoStops())
      turnTo(to, turnDuration(map.getBearing(), to.bearing))
    },
    true,
  )

  // One finger or the mouse turns the camera. A second finger ends that turn and hands over to
  // MapLibre's pinch-rotate, which stops the settling turn and settles through moveend like any
  // other user move.
  container.addEventListener('pointerdown', (down) => {
    endOrbit?.(down.timeStamp)
    if (!down.isPrimary || down.button !== 0 || !canTurn()) return
    const startBearing = map.getBearing()
    let orbiting = false
    let samples: { t: number; bearing: number }[] = []
    // A press released outside the map never sends its pointerup here, so a move with the button up ends it.
    const move = (e: PointerEvent) => {
      if ((e.buttons & 1) === 0) return end(e.timeStamp)
      const dx = e.clientX - down.clientX
      if (!orbiting && Math.abs(dx) < SLOP) return
      if (!orbiting) {
        orbiting = true
        container.setPointerCapture(down.pointerId)
        map.stop()
      }
      const bearing = startBearing - dx * DEG_PER_PX
      map.setBearing(bearing, { rig: 'orbit' })
      samples = [...samples.filter((s) => e.timeStamp - s.t < VELOCITY_WINDOW), { t: e.timeStamp, bearing }]
    }
    // Given the time the drag ended, settles on the photo its last moments were heading for.
    // Without one it stops where it is.
    const end = (at?: number) => {
      endOrbit = null
      container.removeEventListener('pointermove', move)
      container.removeEventListener('pointerup', release)
      container.removeEventListener('pointercancel', release)
      if (container.hasPointerCapture(down.pointerId)) container.releasePointerCapture(down.pointerId)
      if (!orbiting || at === undefined) return
      const recent = samples.filter((s) => at - s.t < VELOCITY_WINDOW)
      const [first, last] = [recent[0], recent[recent.length - 1]]
      const velocity = last && last.t > first.t ? ((last.bearing - first.bearing) / (last.t - first.t)) * 1000 : 0
      const { stop, duration } = orbitRest(map.getBearing(), velocity, photoStops())
      turnTo(stop, duration)
    }
    const release = (e: PointerEvent) => end(e.timeStamp)
    endOrbit = end
    container.addEventListener('pointermove', move)
    container.addEventListener('pointerup', release)
    container.addEventListener('pointercancel', release)
  })

  // Safari's trackpad pinch-rotate arrives only as WebKit gesture events, which MapLibre ignores. On a
  // touch screen Safari sends them for a pinch too, which MapLibre already turns.
  let gestureStart: number | null = null
  const rotation = (e: Event) => ('rotation' in e && typeof e.rotation === 'number' ? e.rotation : 0)
  container.addEventListener('gesturestart', (e) => {
    if (!canTurn() || navigator.maxTouchPoints > 0) return
    e.preventDefault()
    endOrbit?.(e.timeStamp)
    map.stop()
    gestureStart = map.getBearing() + rotation(e)
  })
  container.addEventListener('gesturechange', (e) => {
    if (gestureStart === null) return
    e.preventDefault()
    map.setBearing(gestureStart - rotation(e), { rig: 'orbit' })
  })
  container.addEventListener('gestureend', () => {
    if (gestureStart === null) return
    gestureStart = null
    const stop = nearest(map.getBearing(), photoStops())
    turnTo(stop, turnDuration(map.getBearing(), stop.bearing))
  })

  return {
    // Takes the selected property, its photos and how much of the map's right side the chat covers.
    // Calling it again with unchanged values does nothing.
    update(next: typeof input) {
      const prev = input
      input = next
      const now = performance.now()
      const subjectChanged = next.subject?.id !== prev.subject?.id
      const insetChanged = next.chatInset !== prev.chatInset
      const before = photos.length

      if (subjectChanged) {
        leaving.push(...photos.map((p) => ({ layer: p.layer, quad: p.view.quad, from: opacity.get(p.layer) ?? 0, at: now })))
        if (document.hidden) dropLeaving()
        photos = []
        shown = false
        userMoved = false
        stance = 'photo'
        settlingOut = false
        flight = null
        aim = null
        endOrbit?.()
        gestureStart = null
        for (const zoom of [map.scrollZoom, map.touchZoomRotate]) {
          zoom.disable()
          zoom.enable(next.subject ? { around: 'center' } : undefined)
        }
      }
      if (insetChanged) photos = photos.map((p) => ({ ...p, stop: stopOf(p.view) }))

      const views = next.subject && next.obliques.status === 'ready' ? next.obliques.views : []
      const missing = views.filter((v) => !photos.some((p) => p.view.direction === v.direction))
      if (missing.length) photos = [...photos, ...missing.map(addPhoto)]

      const subject = next.subject
      const nextStops = currentStops()
      const changed = nextStops.length !== stops.length || nextStops.some((stop, i) => !sameStop(stop, stops[i]))
      if (subjectChanged || changed) startRamp()
      stops = nextStops
      const target = stops[0]
      // Until the first photo shows, the approach heads wherever it is now known to rest.
      const retarget = subject && before === 0 && target && changed

      if (subjectChanged && subject) {
        performance.mark('oblique:select', { detail: subject.id })
        flight = { start: now, end: now + FLIGHT }
        if (target) map.flyTo({ ...fullPose(target), padding: padding(), duration: FLIGHT }, { rig: 'select' })
      } else if (retarget && inFlight()) {
        chase()
      } else if (retarget && !userMoved) {
        flight = { start: now, end: now + 800 }
        map.easeTo({ ...fullPose(target), padding: padding(), duration: 800 }, { rig: 'select' })
      } else if (subject && insetChanged && !refit(isLocked, 300)) {
        map.easeTo({ padding: padding(), duration: 300 }, { rig: 'refit' })
      }
      kick()
    },

    // The compass. On a photo it turns to the one facing north, or with none eases out to the flat
    // map facing north; off the photos it only turns the map north. A click mid-swoop is ignored,
    // because stopping the flight would leave the camera hanging partway down.
    faceNorth() {
      if (flight && performance.now() < flight.end && map.isMoving()) return
      if (mixNow() <= 0.5) return map.easeTo({ bearing: 0, duration: 500 }, { rig: 'compass' })
      const north = photos.find((p) => p.view.direction === 'north')
      if (north) return turnTo(north.stop, turnDuration(map.getBearing(), north.stop.bearing))
      map.easeTo({ bearing: 0, zoom: flatZoom(poseAt(0, photoStops()).fit), padding: padding(), duration: 700 }, { rig: 'compass' })
    },

    detach() {
      document.removeEventListener('visibilitychange', onVisibility)
      cancelAnimationFrame(frame)
      frame = 0
      map.setTransformCameraUpdate(null)
    },
  }
}

declare global {
  interface Window {
    // Dev builds only: how many rendered frames showed a photo edge against the map around it.
    __obliqueSeam?: { frames: number; checked: number; violations: number; worst: number }
  }
}

// Dev builds only. After each rendered frame, every photo with any opacity must lie under all four
// corners of the map, found by unprojecting them to the ground. Counts frames into
// window.__obliqueSeam and warns on each one that fails, with how far outside the worst corner lay.
function checkSeams(map: maplibregl.Map, drapes: { layer: string; quad: ObliquePose['quad'] }[], opacity: Map<string, number>) {
  const seam = (window.__obliqueSeam ??= { frames: 0, checked: 0, violations: 0, worst: 0 })
  seam.frames++
  const visible = drapes.filter((d) => (opacity.get(d.layer) ?? 0) > 0)
  if (!visible.length) return
  seam.checked++
  const { clientWidth: w, clientHeight: h } = map.getCanvas()
  const corners = [[0, 0], [w, 0], [w, h], [0, h]].map(([x, y]) => map.unproject([x, y]).toArray())
  for (const { layer, quad } of visible) {
    const [lon0, lat0] = quad[0]
    const k = Math.cos((lat0 * Math.PI) / 180)
    const local = ([lon, lat]: LngLat) => [(lon - lon0) * 111_320 * k, (lat - lat0) * 111_320]
    const ring = quad.map(local)
    const turn = Math.sign(ring.reduce((sum, [x, y], i) => sum + x * ring[(i + 1) % 4][1] - ring[(i + 1) % 4][0] * y, 0))
    // Metres the corner lies outside the photo's ground outline, or 0 inside it.
    const outside = (c: LngLat) => {
      const [px, py] = local(c)
      return Math.max(0, ...ring.map(([ax, ay], i) => {
        const [bx, by] = ring[(i + 1) % 4]
        return (turn * ((bx - ax) * (ay - py) - (by - ay) * (ax - px))) / Math.hypot(bx - ax, by - ay)
      }))
    }
    const worst = Math.max(...corners.map(outside))
    if (worst > 0.01) {
      seam.violations++
      seam.worst = Math.max(seam.worst, worst)
      console.warn(`oblique seam: ${layer} at opacity ${opacity.get(layer)?.toFixed(3)} leaves a map corner ${worst.toFixed(1)} m outside it`)
    }
  }
}

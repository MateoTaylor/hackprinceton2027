import { LoaderCircle, Plus, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import type { Direction, ObliqueIndex } from '../../../shared/api'
import { callOp, getJson, OpCallError } from '../api'
import { DIRECTIONS } from '../obliques'
import type { PanelProps } from '../tools'
import { useWrites } from '../view'
import { facesCamera, fitOnWall, formatLength, hatch, hitWall, MIN_SIDE_M, project, signCorners, sizeProblem, wallPlaneAt, type Camera, type Placement, type Vec2, type Wall } from './facade'
import { fitted, LOOK_DEG, panned, turnRest, turnStep, viewBoxOf, zoomedAbout, type Box, type Zoom } from './photoView'
import './signage.css'

const DEFAULT_SIZE = { widthM: 3, heightM: 1 }
const DEBOUNCE_MS = 300
// The photo frames the building with this much of its own size around it.
const FRAME_MARGIN = 0.35
// The hatch on a sign keeps its lines this many screen pixels apart at any size or zoom.
const HATCH_PX = 9
// As on the map's oblique view: a press moving less than SLOP pixels is a click, and a drag turns
// DEG_PER_PX degrees per pixel before it settles on the nearest photo.
const SLOP = 4
const DEG_PER_PX = 0.3

type Sign = Placement & { id: string; wallIndex: number }
type Signs = { version: number; signs: Sign[] }
type View = Camera & { widthPx: number; heightPx: number; confidence: number }
type Measured = {
  signId: string
  areaM2: number
  bottomAboveGroundM: number
  topAboveGroundM: number
  lift: { label: string; workingHeightM: number } | null
}
type Draft = { id: string; widthM: string; heightM: string }
// A sign being dragged or resized, with the wall point it was grabbed by.
type Gesture = { kind: 'move' | 'resize'; id: string; grab: { alongM: number; heightM: number }; start: Placement; now: Placement }
// A press on the photo itself: it pans a magnified photo, or turns an unmagnified one. `perPx` is
// photo pixels per screen pixel when it began.
type Drag = { pointerId: number; x: number; y: number; zoom: Zoom; perPx: number; dx: number; moved: boolean }

const bearingGap = (a: number, b: number) => Math.abs((((a - b) % 360) + 540) % 360 - 180)
const rotationOf = (e: Event) => ('rotation' in e && typeof e.rotation === 'number' ? e.rotation : 0)
const scaleOf = (e: Event) => ('scale' in e && typeof e.scale === 'number' ? e.scale : 1)
const points = (corners: (Vec2 | null)[]) => (corners.every((p) => p !== null) ? corners.map((p) => p.join(',')).join(' ') : null)

// The Signage panel. It shows the property's oblique photos, one heading at a time, and hangs
// blank signs on the building's outside walls, which come from the Vexcel outline and height.
// Signs live in the building's frame, so every heading shows the same signs. The photo fills the
// panel and moves like the map's oblique view: pinch or wheel zooms, a drag pans a zoomed photo
// and turns an unzoomed one, and a pinch-rotate, the arrow keys or the compass turn to another
// heading. The sign controls sit top-left and the selected sign's card on the right.
export default function SignagePanel({ property }: PanelProps) {
  const propertyId = property.id
  const [directions, setDirections] = useState<Direction[] | null>(null)
  const [direction, setDirection] = useState<Direction | null>(null)
  const [views, setViews] = useState<Partial<Record<Direction, View>>>({})
  const [walls, setWalls] = useState<Wall[] | null>(null)
  const [document, setDocument] = useState<Signs | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [armed, setArmed] = useState(false)
  const [outline, setOutline] = useState(true)
  const [notice, setNotice] = useState<string | null>(null)
  const [measured, setMeasured] = useState<Measured | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [gesture, setGesture] = useState<Gesture | null>(null)
  const [photoLoaded, setPhotoLoaded] = useState(false)
  const [zoom, setZoom] = useState<Zoom | null>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [limit, setLimit] = useState<string | null>(null)
  const [screenPx, setScreenPx] = useState({ width: 0, height: 0 })
  const svg = useRef<SVGSVGElement>(null)
  const photo = useRef<HTMLDivElement>(null)
  const version = useRef(0)
  const lastWrite = useRef<Promise<unknown>>(Promise.resolve())

  const view = direction ? views[direction] : undefined
  const signs = document?.signs ?? []
  const selected = signs.find(({ id }) => id === selectedId) ?? null

  const accept = (next: Signs) => {
    version.current = next.version
    setNotice(null)
    setDocument(next)
    return next
  }
  // The panel checks sizes against the wall itself, so a write the server still refuses as input
  // gets a plain sentence rather than its schema message, which is written for Proppy.
  const fail = (error: unknown) => {
    if (!(error instanceof OpCallError)) setNotice('The signs could not be saved.')
    else setNotice(error.code === 'invalid_input' ? 'The sign does not fit there on its wall.' : `${error.message} ${error.hint}`)
    return null
  }
  const load = () =>
    callOp<Signs, { walls: Wall[] }>('signage_get', { propertyId }, { detail: true }).then(({ result, detail }) => {
      setWalls(detail.walls)
      return accept(result)
    }, fail)

  // Sends one write at the version last read, after any write still on its way. A write that lost
  // to a newer version reloads the signs.
  const write = (name: string, input: object) => {
    const sent = lastWrite.current.then(() =>
      callOp<{ version: number; sign: Sign | null }>(name, { propertyId, ...input, expectedVersion: version.current }).then(
        async ({ result }) => {
          await load()
          return result
        },
        (error: unknown) => {
          if (error instanceof OpCallError && error.code === 'conflict') return load().then(() => fail(error))
          return fail(error)
        },
      ),
    )
    lastWrite.current = sent
    return sent
  }

  // Proppy, another tab or a script changed the signs: read them again once this panel's own
  // writes have landed, so the next edit goes out at the new version.
  useWrites((event) => {
    if (event.propertyId !== propertyId || !event.op.startsWith('signage_')) return
    lastWrite.current = lastWrite.current.then(load)
  })

  useEffect(() => {
    void load()
    const controller = new AbortController()
    getJson(`/api/oblique/${encodeURIComponent(propertyId)}`, controller.signal).then(
      (index) => {
        const available = DIRECTIONS.filter((d) => (index as ObliqueIndex).directions.includes(d))
        setDirections(available)
        setDirection(available[0] ?? null)
      },
      () => !controller.signal.aborted && setDirections([]),
    )
    return () => controller.abort()
  }, [propertyId])

  useEffect(() => {
    if (!direction || views[direction]) return
    callOp<Omit<View, 'matrix'> & { camera: number[] }>('signage_camera', { propertyId, direction }).then(
      ({ result: { camera, ...rest } }) => setViews((all) => ({ ...all, [direction]: { ...rest, matrix: camera } })),
      fail,
    )
  }, [direction])

  useEffect(() => setPhotoLoaded(false), [direction])

  useEffect(() => {
    if (!selected) return setMeasured(null)
    const controller = new AbortController()
    callOp<Measured>('signage_measure', { propertyId, signId: selected.id }, { signal: controller.signal }).then(
      ({ result }) => setMeasured(result),
      (error: unknown) => !controller.signal.aborted && fail(error),
    )
    return () => controller.abort()
  }, [selected?.id, document?.version])

  // A typed size is saved once it fits the sign's wall, moving the sign as little as it must to stay
  // on the wall. One that does not fit says why under the inputs and is not sent. Only typing
  // runs this: a sign or wall that changes under an unchanged draft sends nothing.
  useEffect(() => {
    const sign = draft && signs.find(({ id }) => id === draft.id)
    const wall = sign && walls?.[sign.wallIndex]
    if (!draft || !sign || !wall || draft.widthM === '' || draft.heightM === '') return setLimit(null)
    const sizeM = { widthM: Number(draft.widthM), heightM: Number(draft.heightM) }
    const problem = Number.isFinite(sizeM.widthM) && Number.isFinite(sizeM.heightM) ? sizeProblem(wall, sizeM) : 'Type the size in metres.'
    setLimit(problem)
    if (problem) return
    const timer = setTimeout(() => void write('signage_move', { signId: draft.id, ...fitOnWall(wall, { ...sign, sizeM }) }).then((saved) => saved ?? setDraft(null)), DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [draft])

  useEffect(() => setLimit(null), [selectedId])

  useEffect(() => {
    const element = photo.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => setScreenPx({ width: entry.contentRect.width, height: entry.contentRect.height }))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // The part of the photo around the building, so its facades fill the panel.
  const frame = useMemo((): Box | null => {
    if (!view || !walls) return null
    const seen = walls.flatMap((wall) => [project(view, [...wall.start, wall.baseM]), project(view, [...wall.start, wall.topM])]).filter((p) => p !== null)
    const [xs, ys] = [seen.map((p) => p[0]), seen.map((p) => p[1])]
    const [left, right, top, bottom] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
    const margin = Math.max(right - left, bottom - top) * FRAME_MARGIN
    const x = Math.max(0, left - margin)
    const y = Math.max(0, top - margin)
    return { x, y, w: Math.min(view.widthPx, right + margin) - x, h: Math.min(view.heightPx, bottom + margin) - y }
  }, [view, walls])

  // A new heading or building starts unmagnified.
  useEffect(() => setZoom(frame && fitted(frame)), [frame])

  const box = frame && viewBoxOf(frame, zoom ?? fitted(frame))
  // Screen pixels per photo pixel, as the SVG's default `meet` fit draws the viewBox.
  const pxPerPhoto = box ? Math.min(screenPx.width / box.w, screenPx.height / box.h) || 1 : 1

  const turnTo = (next: Direction) => {
    if (next === direction) return
    setDirection(next)
    setGesture(null)
  }

  // Wheel and trackpad pinch (a wheel with ctrlKey in Chrome and Firefox) zoom about the pointer.
  // Safari sends a trackpad pinch-rotate as gesture events: the pinch zooms and the rotation turns
  // to the nearest heading when it ends, as on the map. Listeners are native so they can
  // preventDefault the page zoom.
  useEffect(() => {
    const element = photo.current
    if (!element || !frame || !direction || !directions) return
    const pixelAt = (clientX: number, clientY: number): Vec2 | null => {
      const matrix = svg.current?.getScreenCTM()?.inverse()
      if (!matrix) return null
      const { x, y } = new DOMPoint(clientX, clientY).matrixTransform(matrix)
      return [x, y]
    }
    const wheel = (e: WheelEvent) => {
      e.preventDefault()
      const at = pixelAt(e.clientX, e.clientY)
      const lines = e.deltaMode === 1 ? 16 : 1
      if (at) setZoom((z) => zoomedAbout(frame, z ?? fitted(frame), Math.exp(-e.deltaY * lines * (e.ctrlKey ? 0.01 : 0.002)), at))
    }
    let pinch: { scale: number; at: Vec2 } | null = null
    const gestureStart = (e: Event) => {
      if (navigator.maxTouchPoints > 0) return
      e.preventDefault()
      const { left, top, width, height } = element.getBoundingClientRect()
      const at = pixelAt(left + width / 2, top + height / 2)
      pinch = at && { scale: 1, at }
    }
    const gestureChange = (e: Event) => {
      if (!pinch) return
      e.preventDefault()
      const factor = scaleOf(e) / pinch.scale
      const at = pinch.at
      pinch = { scale: scaleOf(e), at }
      setZoom((z) => zoomedAbout(frame, z ?? fitted(frame), factor, at))
    }
    const gestureEnd = (e: Event) => {
      if (!pinch) return
      pinch = null
      turnTo(turnRest(directions, direction, -rotationOf(e)))
    }
    element.addEventListener('wheel', wheel, { passive: false })
    element.addEventListener('gesturestart', gestureStart)
    element.addEventListener('gesturechange', gestureChange)
    element.addEventListener('gestureend', gestureEnd)
    return () => {
      element.removeEventListener('wheel', wheel)
      element.removeEventListener('gesturestart', gestureStart)
      element.removeEventListener('gesturechange', gestureChange)
      element.removeEventListener('gestureend', gestureEnd)
    }
  }, [frame, direction, directions])

  const pixelOf = (event: { clientX: number; clientY: number }): Vec2 | null => {
    const matrix = svg.current?.getScreenCTM()?.inverse()
    if (!matrix) return null
    const { x, y } = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix)
    return [x, y]
  }

  const place = async (event: PointerEvent) => {
    const pixel = pixelOf(event)
    if (!view || !walls || !pixel) return
    const hit = hitWall(view, walls, pixel)
    if (!hit) return setNotice('Click a wall of the building.')
    setArmed(false)
    const fitted = fitOnWall(hit.wall, { alongM: hit.alongM, bottomM: hit.heightM - DEFAULT_SIZE.heightM / 2, sizeM: DEFAULT_SIZE })
    const saved = await write('signage_place', { wallIndex: hit.wall.index, ...fitted })
    if (saved?.sign) setSelectedId(saved.sign.id)
  }

  const begin = (kind: Gesture['kind'], sign: Sign) => (event: PointerEvent) => {
    event.stopPropagation()
    setSelectedId(sign.id)
    setDraft(null)
    setLimit(null)
    const pixel = pixelOf(event)
    const hit = view && walls && pixel && wallPlaneAt(view, walls[sign.wallIndex], pixel)
    if (!hit) return
    svg.current?.setPointerCapture(event.pointerId)
    setGesture({ kind, id: sign.id, grab: hit, start: sign, now: sign })
  }

  // A press on the photo, not on a sign. A click places an armed sign or clears the selection.
  const press = (event: PointerEvent) => {
    if (armed) return void place(event)
    if (event.button !== 0 || !zoom) return
    svg.current?.setPointerCapture(event.pointerId)
    setDrag({ pointerId: event.pointerId, x: event.clientX, y: event.clientY, zoom, perPx: 1 / pxPerPhoto, dx: 0, moved: false })
  }

  const move = (event: PointerEvent) => {
    if (drag && frame && event.pointerId === drag.pointerId) {
      const [dx, dy] = [event.clientX - drag.x, event.clientY - drag.y]
      const moved = drag.moved || Math.hypot(dx, dy) >= SLOP
      if (drag.zoom.scale > 1) setZoom(panned(frame, drag.zoom, -dx * drag.perPx, -dy * drag.perPx))
      setDrag({ ...drag, dx, moved })
      return
    }
    const pixel = pixelOf(event)
    const sign = gesture && signs.find(({ id }) => id === gesture.id)
    if (!gesture || !sign || !view || !walls || !pixel) return
    const wall = walls[sign.wallIndex]
    const hit = wallPlaneAt(view, wall, pixel)
    if (!hit) return
    const { start } = gesture
    const [dx, dz] = [hit.alongM - gesture.grab.alongM, hit.heightM - gesture.grab.heightM]
    if (gesture.kind === 'move') return setGesture({ ...gesture, now: fitOnWall(wall, { ...start, alongM: start.alongM + dx, bottomM: start.bottomM + dz }) })
    // The handle grows the sign up and right from its bottom-left corner. Past the wall's edge it
    // grows the other way, and past the whole wall it stops and says why.
    const left = start.alongM - start.sizeM.widthM / 2
    const wanted = { widthM: Math.max(MIN_SIDE_M, start.sizeM.widthM + dx), heightM: Math.max(MIN_SIDE_M, start.sizeM.heightM + dz) }
    setLimit(sizeProblem(wall, wanted))
    setGesture({ ...gesture, now: fitOnWall(wall, { alongM: left + wanted.widthM / 2, bottomM: start.bottomM, sizeM: wanted }) })
  }

  const finish = (event: PointerEvent) => {
    if (drag && event.pointerId === drag.pointerId) {
      setDrag(null)
      if (!drag.moved) return setSelectedId(null)
      // Dragging left turns clockwise, as on the map.
      if (drag.zoom.scale <= 1 && direction && directions) turnTo(turnRest(directions, direction, -drag.dx * DEG_PER_PX))
      return
    }
    if (!gesture) return
    const { id, start, now } = gesture
    setGesture(null)
    if (JSON.stringify(start) !== JSON.stringify({ ...start, ...now })) void write('signage_move', { signId: id, alongM: now.alongM, bottomM: now.bottomM, sizeM: now.sizeM })
  }

  const select = (sign: Sign) => {
    setSelectedId(sign.id)
    const wall = walls?.[sign.wallIndex]
    if (!wall || !directions?.length || (view && facesCamera(wall, view))) return
    // A wall facing F is seen best by the camera looking toward F + 180.
    const best = directions.reduce((a, b) => (bearingGap(LOOK_DEG[a], wall.facingDeg + 180) <= bearingGap(LOOK_DEG[b], wall.facingDeg + 180) ? a : b))
    setDirection(best)
  }

  const key = (event: KeyboardEvent) => {
    if ((event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') || !direction || !directions) return
    event.preventDefault()
    turnTo(turnStep(directions, direction, event.key === 'ArrowRight' ? 1 : -1))
  }

  const faceNorth = () => {
    if (directions?.includes('north')) turnTo('north')
    if (frame) setZoom(fitted(frame))
  }

  const remove = async (id: string) => {
    setSelectedId(null)
    setDraft(null)
    await write('signage_remove', { signId: id })
  }

  if (directions?.length === 0) return <p className="panel-state">Vexcel has no angled photo of this property.</p>

  const shown = (sign: Sign): Sign => (gesture?.id === sign.id ? { ...sign, ...gesture.now } : sign)
  const facing = (wall: Wall) => view !== undefined && facesCamera(wall, view)
  const outlinePath =
    view && walls
      ? walls
          .filter(facing)
          .map((wall) => points([wall.baseM, wall.baseM, wall.topM, wall.topM].map((z, i) => project(view, [...(i === 0 || i === 3 ? wall.start : wall.end), z]))))
          .filter((p) => p !== null)
          .map((p) => `M${p.replaceAll(' ', 'L')}Z`)
          .join('')
      : ''
  const size = selected && (draft?.id === selected.id ? draft : { id: selected.id, widthM: String(shown(selected).sizeM.widthM), heightM: String(shown(selected).sizeM.heightM) })
  const reading = measured && measured.signId === selected?.id ? measured : null
  const selectedHidden = selected && walls && view && !facesCamera(walls[selected.wallIndex], view)
  // An unzoomed photo follows a turning drag a little, the way the map starts to swing.
  const swing = drag?.moved && drag.zoom.scale <= 1 ? { transform: `translateX(${drag.dx * 0.25}px)` } : undefined

  return (
    <div className="signage-panel">
      <div ref={photo} className="signage-photo" tabIndex={0} aria-label="Oblique photo. Arrow keys turn to another heading." onKeyDown={key}>
        {direction && box && view && (
          <svg
            ref={svg}
            viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`}
            className={[armed && 'armed', zoom && zoom.scale > 1 && 'zoomed', drag?.moved && 'dragging'].filter(Boolean).join(' ') || undefined}
            style={swing}
            onPointerDown={press}
            onPointerMove={move}
            onPointerUp={finish}
            onPointerCancel={finish}
          >
            <image href={`/api/oblique/${encodeURIComponent(propertyId)}/${direction}`} width={view.widthPx} height={view.heightPx} onLoad={() => setPhotoLoaded(true)} />
            {photoLoaded && outline && <path className="signage-outline" d={outlinePath} />}
            {photoLoaded &&
              walls &&
              signs.map((stored) => {
                const sign = shown(stored)
                const wall = walls[sign.wallIndex]
                if (!wall || !facing(wall)) return null
                const corners = signCorners(wall, sign).map((corner) => project(view, corner))
                const polygon = points(corners)
                if (!polygon) return null
                const isSelected = sign.id === selectedId
                return (
                  <g key={sign.id} className={isSelected ? 'signage-sign selected' : 'signage-sign'}>
                    <polygon points={polygon} onPointerDown={armed ? undefined : begin('move', stored)} />
                    <path className="signage-hatch" d={hatchPath(view, wall, sign, corners, pxPerPhoto)} />
                    {isSelected && corners[2] && <circle className="signage-handle" cx={corners[2][0]} cy={corners[2][1]} r={8 / pxPerPhoto} onPointerDown={begin('resize', stored)} />}
                  </g>
                )
              })}
          </svg>
        )}
        {(!frame || !photoLoaded) && (
          <p className="signage-status signage-loading">
            <LoaderCircle className="panel-spinner" size={16} aria-hidden />
            Loading the photo
          </p>
        )}
      </div>

      <p className="signage-status signage-hint" role="status">
        {notice ??
          (selectedHidden
            ? 'This sign faces away from this photo.'
            : armed
              ? 'Click a wall to hang the sign.'
              : view
                ? `Walls from the Vexcel outline and height. Photo fit confidence ${view.confidence.toFixed(2)}.`
                : null)}
      </p>

      {direction && (
        <button
          className="surface-pill signage-compass"
          aria-label={`Looking ${direction}, face north`}
          title={`Looking ${direction}. Drag, pinch-rotate or use the arrow keys to turn.`}
          onClick={faceNorth}
        >
          <svg width="16" height="24" viewBox="0 0 16 24" aria-hidden="true" style={{ rotate: `${-LOOK_DEG[direction]}deg` }}>
            <path d="M8 0 15 12H1Z" fill="var(--compass)" />
            <path d="M8 24 1 12h14Z" fill="var(--color-text-muted)" />
          </svg>
        </button>
      )}

      <div className="signage-tools">
        <div className="signage-row">
          <button className="button" disabled={!view || !walls} aria-pressed={armed} onClick={() => (setArmed(!armed), setNotice(null))}>
            {!armed && <Plus size={16} aria-hidden />}
            {armed ? 'Cancel' : 'Place sign'}
          </button>
          <div className="chip-row" role="group" aria-label="Signs">
            {signs.map((sign, index) => (
              <button key={sign.id} className="chip" aria-pressed={sign.id === selectedId} onClick={() => select(sign)}>
                Sign {index + 1}
              </button>
            ))}
          </div>
          <button className="signage-switch" role="switch" aria-checked={outline} onClick={() => setOutline(!outline)}>
            <span aria-hidden />
            Walls
          </button>
        </div>
      </div>

      {selected && size && (
        <div className="signage-card">
          <div className="signage-row">
            {(['widthM', 'heightM'] as const).map((side) => (
              <label key={side} className="signage-field">
                {side === 'widthM' ? 'Width' : 'Height'}
                <input
                  type="number"
                  step={0.1}
                  min={MIN_SIDE_M}
                  aria-invalid={limit !== null}
                  value={size[side]}
                  onChange={(event) => setDraft({ ...size, [side]: event.target.value })}
                />
                m
              </label>
            ))}
            <button className="circle signage-remove" aria-label="Remove this sign" onClick={() => void remove(selected.id)}>
              <Trash2 size={16} aria-hidden />
            </button>
          </div>
          {limit && (
            <p className="signage-limit" role="alert">
              {limit}
            </p>
          )}

          <dl className="signage-readout">
            <Reading label="Width" value={formatLength(shown(selected).sizeM.widthM)} />
            <Reading label="Height" value={formatLength(shown(selected).sizeM.heightM)} />
            <Reading label="Area" value={reading ? `${reading.areaM2.toFixed(2)} m²` : '…'} />
            <Reading label="Bottom above ground" value={reading ? formatLength(reading.bottomAboveGroundM) : '…'} />
            <Reading label="Top above ground" value={reading ? formatLength(reading.topAboveGroundM) : '…'} />
            <Reading label="Lift" value={lift(reading)} />
          </dl>
        </div>
      )}
    </div>
  )
}

// The hatch on a sign as one SVG path, its lines HATCH_PX screen pixels apart where the sign is
// drawn smallest, so it reads the same on a tiny sign and a whole facade at any zoom.
function hatchPath(view: View, wall: Wall, sign: Placement, corners: (Vec2 | null)[], pxPerPhoto: number) {
  const [a, b, , d] = corners
  if (!a || !b || !d) return ''
  const pxPerM = Math.min(Math.hypot(b[0] - a[0], b[1] - a[1]) / sign.sizeM.widthM, Math.hypot(d[0] - a[0], d[1] - a[1]) / sign.sizeM.heightM) * pxPerPhoto
  if (!(pxPerM > 0)) return ''
  return hatch(wall, sign, HATCH_PX / pxPerM)
    .map((line) => line.map((end) => project(view, end)))
    .filter((line) => line.every((p) => p !== null))
    .map(([p, q]) => `M${p.join(',')}L${q.join(',')}`)
    .join('')
}

function Reading({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}

function lift(reading: Measured | null) {
  if (!reading) return '…'
  if (reading.lift) return `${reading.lift.label} · reaches ${reading.lift.workingHeightM.toFixed(1)} m`
  return reading.topAboveGroundM <= 2 ? 'None needed, reachable from the ground' : 'No lift in the catalogue reaches it'
}

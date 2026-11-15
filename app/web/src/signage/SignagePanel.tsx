import { LoaderCircle, Plus, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import type { Direction, ObliqueIndex } from '../../../shared/api'
import { callOp, getJson, OpCallError } from '../api'
import { DIRECTIONS } from '../obliques'
import type { PanelProps } from '../tools'
import { useWrites } from '../view'
import { facesCamera, fitOnWall, formatLength, hitWall, project, signCorners, wallPlaneAt, type Camera, type Placement, type Vec2, type Wall } from './facade'
import './signage.css'

const DEFAULT_SIZE = { widthM: 3, heightM: 1 }
const SIZE_RANGE = { min: 0.2, max: 20 }
const DEBOUNCE_MS = 300
// The photo frames the building with this much of its own size around it.
const FRAME_MARGIN = 0.35
const LOOK_DEG = { north: 0, east: 90, south: 180, west: 270 } satisfies Record<Direction, number>

type Sign = Placement & { id: string; wallIndex: number }
type Signs = { version: number; signs: Sign[] }
type View = Camera & { widthPx: number; heightPx: number; confidence: number }
type Measured = {
  signId: string
  areaM2: number
  bottomAboveGroundM: number
  topAboveGroundM: number
  facingDeg: number
  lift: { label: string; workingHeightM: number } | null
  confidence: number
}
type Draft = { id: string; widthM: string; heightM: string }
// A sign being dragged or resized, with the wall point it was grabbed by.
type Gesture = { kind: 'move' | 'resize'; id: string; grab: { alongM: number; heightM: number }; start: Placement; now: Placement }

const bearingGap = (a: number, b: number) => Math.abs((((a - b) % 360) + 540) % 360 - 180)
const points = (corners: (Vec2 | null)[]) => (corners.every((p) => p !== null) ? corners.map((p) => p.join(',')).join(' ') : null)

// The Signage panel. It shows the property's oblique photos, one heading at a time, and hangs
// blank signs on the building's outside walls, which come from the Vexcel outline and height.
// Signs live in the building's frame, so every heading shows the same signs.
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
  const svg = useRef<SVGSVGElement>(null)
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
  const fail = (error: unknown) => {
    setNotice(error instanceof OpCallError ? `${error.message} ${error.hint}` : 'The signs could not be saved.')
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

  useEffect(() => {
  // Proppy, another tab or a script changed the signs: read them again once this panel's own
  // writes have landed, so the next edit goes out at the new version.
  useWrites((event) => {
    if (event.propertyId !== propertyId || !event.op.startsWith('signage_')) return
    lastWrite.current = lastWrite.current.then(load)
  })

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

  useEffect(() => {
    if (!draft) return
    const sizeM = { widthM: Number(draft.widthM), heightM: Number(draft.heightM) }
    if (!Object.values(sizeM).every((value) => value >= SIZE_RANGE.min && value <= SIZE_RANGE.max)) return
    const timer = setTimeout(() => void write('signage_move', { signId: draft.id, sizeM }).then((saved) => saved ?? setDraft(null)), DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [draft])

  // The part of the photo around the building, so its facades fill the panel.
  const frame = useMemo(() => {
    if (!view || !walls) return null
    const seen = walls.flatMap((wall) => [project(view, [...wall.start, wall.baseM]), project(view, [...wall.start, wall.topM])]).filter((p) => p !== null)
    const [xs, ys] = [seen.map((p) => p[0]), seen.map((p) => p[1])]
    const [left, right, top, bottom] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
    const margin = Math.max(right - left, bottom - top) * FRAME_MARGIN
    const x = Math.max(0, left - margin)
    const y = Math.max(0, top - margin)
    return `${x} ${y} ${Math.min(view.widthPx, right + margin) - x} ${Math.min(view.heightPx, bottom + margin) - y}`
  }, [view, walls])

  const pixelOf = (event: PointerEvent): Vec2 | null => {
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
    const pixel = pixelOf(event)
    const hit = view && walls && pixel && wallPlaneAt(view, walls[sign.wallIndex], pixel)
    if (!hit) return
    svg.current?.setPointerCapture(event.pointerId)
    setGesture({ kind, id: sign.id, grab: hit, start: sign, now: sign })
  }

  const drag = (event: PointerEvent) => {
    const pixel = pixelOf(event)
    const sign = gesture && signs.find(({ id }) => id === gesture.id)
    if (!gesture || !sign || !view || !walls || !pixel) return
    const wall = walls[sign.wallIndex]
    const hit = wallPlaneAt(view, wall, pixel)
    if (!hit) return
    const { start } = gesture
    const [dx, dz] = [hit.alongM - gesture.grab.alongM, hit.heightM - gesture.grab.heightM]
    if (gesture.kind === 'move') return setGesture({ ...gesture, now: fitOnWall(wall, { ...start, alongM: start.alongM + dx, bottomM: start.bottomM + dz }) })
    const left = start.alongM - start.sizeM.widthM / 2
    const widthM = Math.max(SIZE_RANGE.min, start.sizeM.widthM + dx)
    const heightM = Math.max(SIZE_RANGE.min, start.sizeM.heightM + dz)
    setGesture({ ...gesture, now: fitOnWall(wall, { alongM: left + widthM / 2, bottomM: start.bottomM, sizeM: { widthM, heightM } }) })
  }

  const finish = () => {
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

  return (
    <div className="signage-panel">
      <div className="chip-row" role="group" aria-label="Photo heading">
        {(directions ?? []).map((d) => (
          <button key={d} className="chip" aria-pressed={d === direction} onClick={() => setDirection(d)}>
            Looking {d}
          </button>
        ))}
      </div>

      <div className="signage-photo">
        {direction && frame && view && (
          <svg
            ref={svg}
            viewBox={frame}
            className={armed ? 'armed' : undefined}
            onPointerDown={(event) => (armed ? void place(event) : setSelectedId(null))}
            onPointerMove={drag}
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
                    {isSelected && corners[2] && <circle className="signage-handle" cx={corners[2][0]} cy={corners[2][1]} r={10} onPointerDown={begin('resize', stored)} />}
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

      <p className="signage-status" role="status">
        {notice ??
          (selectedHidden
            ? 'This sign faces away from this photo.'
            : armed
              ? 'Click a wall to hang the sign.'
              : view
                ? `Walls from the Vexcel outline and height. Photo fit confidence ${view.confidence.toFixed(2)}.`
                : ' ')}
      </p>

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

      {selected && size && (
        <>
          <div className="signage-row">
            {(['widthM', 'heightM'] as const).map((side) => (
              <label key={side} className="signage-field">
                {side === 'widthM' ? 'Width' : 'Height'}
                <input type="number" step={0.1} {...SIZE_RANGE} value={size[side]} onChange={(event) => setDraft({ ...size, [side]: event.target.value })} />
                m
              </label>
            ))}
            <button className="circle signage-remove" aria-label="Remove this sign" onClick={() => void remove(selected.id)}>
              <Trash2 size={16} aria-hidden />
            </button>
          </div>

          <dl className="signage-readout">
            <Reading label="Width" value={formatLength(shown(selected).sizeM.widthM)} />
            <Reading label="Height" value={formatLength(shown(selected).sizeM.heightM)} />
            <Reading label="Area" value={reading ? `${reading.areaM2.toFixed(2)} m²` : '…'} />
            <Reading label="Bottom above ground" value={reading ? formatLength(reading.bottomAboveGroundM) : '…'} />
            <Reading label="Top above ground" value={reading ? formatLength(reading.topAboveGroundM) : '…'} />
            <Reading label="Lift" value={lift(reading)} />
          </dl>
          {reading && (
            <p className="signage-status">
              Faces {Math.round(reading.facingDeg)}°. Confidence {reading.confidence.toFixed(2)}. The sign is a blank placeholder. No sign rule is checked.
            </p>
          )}
        </>
      )}
    </div>
  )
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

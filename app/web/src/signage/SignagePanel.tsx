import { LoaderCircle, Plus, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { callOp, OpCallError } from '../api'
import { classifyNormal, formatLength, type PlacedSign } from '../scene/signGeometry'
import { createSignLayer, groundBelow, surfaceAt } from '../scene/signs'
import { isSpaceId } from '../scene/spaces'
import { useScene } from '../scene/useScene'
import type { PanelProps } from '../tools'
import '../scene/scene.css'
import './signage.css'

const SIGN_ID = 'sign_panel'
const DEFAULT_SIZE = { widthM: 2.4, heightM: 0.6 }
const SIZE_RANGE = { min: 0.2, max: 20 }
const DEBOUNCE_MS = 300

type SceneObject = Omit<PlacedSign, 'sizeM'> & { equipmentId: string; sizeM?: PlacedSign['sizeM'] }
type Scene = { version: number; objects: SceneObject[] }
type Measured = {
  objectId: string
  areaM2: number
  bottomAboveGroundM: number | null
  topAboveGroundM: number | null
  lift: { label: string; workingHeightM: number } | null
}
type Draft = { id: string; widthM: string; heightM: string }

const isSign = (object: SceneObject): object is SceneObject & PlacedSign => object.equipmentId === SIGN_ID && object.sizeM !== undefined

// The Signage panel. It opens one of the property's own scans, picked by chip when there are
// several, and keeps the signs of each scan apart.
export default function SignagePanel({ property }: PanelProps) {
  const scans = property.scans.filter(({ modelId }) => isSpaceId(modelId))
  const [spaceId, setSpaceId] = useState(scans.at(0)?.modelId)
  if (!spaceId) return <p className="panel-state">This property has no 3D scan to hang a sign in.</p>

  return (
    <div className="signage-panel">
      {scans.length > 1 && (
        <div className="chip-row" role="group" aria-label="Scan">
          {scans.map(({ modelId, name }) => (
            <button key={modelId} className="chip" aria-pressed={modelId === spaceId} onClick={() => setSpaceId(modelId)}>
              {name}
            </button>
          ))}
        </div>
      )}
      <SignScene key={spaceId} spaceId={spaceId} />
    </div>
  )
}

// One scan with its signs. It hangs blank signs on the walls the user clicks and shows each
// sign's size, its height above the ground and the lift that reaches it. Give it a `key` of
// `spaceId`, because it does not follow a change of scan.
function SignScene({ spaceId }: { spaceId: string }) {
  const { container, viewer } = useScene(spaceId)
  const [scene, setScene] = useState<Scene | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [armed, setArmed] = useState(false)
  const [showMeasures, setShowMeasures] = useState(true)
  const [notice, setNotice] = useState<string | null>(null)
  const [measured, setMeasured] = useState<Measured | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const version = useRef(0)
  const groundTried = useRef(new Set<string>())
  const lastWrite = useRef<Promise<unknown>>(Promise.resolve())

  const signs = useMemo(() => scene?.objects.filter(isSign) ?? [], [scene])
  const selected = signs.find(({ id }) => id === selectedId) ?? null
  const handle = viewer.status === 'ready' ? viewer.handle : null

  const accept = (next: Scene) => {
    version.current = next.version
    setNotice(null)
    setScene(next)
    return next
  }
  const fail = (error: unknown) => {
    setNotice(error instanceof OpCallError ? error.message : 'The scene could not be saved.')
    return null
  }
  const load = () => callOp<Scene>('scene_get', { spaceId }).then(({ result }) => accept(result), fail)

  // Sends one write at the version last read, after any write still on its way. A write that lost
  // to a newer scene reloads it.
  const write = (name: string, input: object) => {
    const sent = lastWrite.current.then(() =>
      callOp<Scene>(name, { spaceId, ...input, expectedVersion: version.current }).then(
        ({ result }) => accept(result),
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
    void load()
  }, [])

  useEffect(() => {
    if (!handle) return
    const layer = createSignLayer(handle)
    layer.show(signs, showMeasures ? selected : null)
    return () => layer.dispose()
  }, [handle, signs, selected, showMeasures])

  // A sign placed through the op alone has no measured ground, so measure it once the scan is open.
  useEffect(() => {
    if (!handle) return
    for (const sign of signs) {
      if (sign.groundY !== undefined || groundTried.current.has(sign.id)) continue
      groundTried.current.add(sign.id)
      const groundY = groundBelow(handle, sign)
      if (groundY !== undefined) void write('scene_move', { objectId: sign.id, groundY })
    }
  }, [handle, signs])

  useEffect(() => {
    if (!selected) return setMeasured(null)
    const controller = new AbortController()
    callOp<Measured>('signage_measure', { spaceId, objectId: selected.id }, { signal: controller.signal }).then(
      ({ result }) => setMeasured(result),
      (error: unknown) => {
        if (!controller.signal.aborted) fail(error)
      },
    )
    return () => controller.abort()
  }, [selected])

  useEffect(() => {
    if (!draft) return
    const sizeM = { widthM: Number(draft.widthM), heightM: Number(draft.heightM) }
    const valid = Object.values(sizeM).every((value) => value >= SIZE_RANGE.min && value <= SIZE_RANGE.max)
    if (!valid) return
    const timer = setTimeout(() => void write('scene_move', { objectId: draft.id, sizeM }).then((saved) => saved ?? setDraft(null)), DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [draft])

  const place = async (event: MouseEvent<HTMLButtonElement>) => {
    if (!handle || event.detail === 0) return
    const box = event.currentTarget.getBoundingClientRect()
    const surface = surfaceAt(handle, {
      x: ((event.clientX - box.left) / box.width) * 2 - 1,
      y: 1 - ((event.clientY - box.top) / box.height) * 2,
    })
    if (!surface || classifyNormal(surface.normal) !== 'wall') return setNotice('Click a wall.')
    const [nx, , nz] = surface.normal
    const yawDeg = (Math.atan2(-nz, nx) * 180) / Math.PI
    const groundY = groundBelow(handle, { id: '', position: surface.point, yawDeg, sizeM: DEFAULT_SIZE })
    setArmed(false)
    const next = await write('scene_place', { equipmentId: SIGN_ID, position: surface.point, anchor: { kind: 'wall', normal: surface.normal }, sizeM: DEFAULT_SIZE, groundY })
    if (next) setSelectedId(next.objects.at(-1)?.id ?? null)
  }

  const toggleArmed = () => {
    setArmed(!armed)
    setNotice(null)
  }

  const remove = async (id: string) => {
    setSelectedId(null)
    setDraft(null)
    await write('scene_remove', { objectId: id })
  }

  const size = selected && (draft?.id === selected.id ? draft : { id: selected.id, widthM: String(selected.sizeM.widthM), heightM: String(selected.sizeM.heightM) })
  const reading = measured && measured.objectId === selected?.id ? measured : null

  return (
    <>
      <div className="scene-viewer" ref={container}>
        {armed && <button className="signage-target" aria-label="Click a wall to hang the sign" onClick={place} />}
      </div>

      <p className="scene-status" role="status">
        {viewer.status === 'loading' && (
          <>
            <LoaderCircle className="panel-spinner" size={16} aria-hidden />
            Loading the scan
          </>
        )}
        {viewer.status === 'error' && <span className="scene-error">{viewer.message}</span>}
        {viewer.status === 'ready' && (notice ?? (armed ? 'Click a wall to hang the sign.' : 'The sign is a blank placeholder. No sign rule is checked.'))}
      </p>

      <div className="signage-row">
        <button className="button" disabled={!handle || !scene} aria-pressed={armed} onClick={toggleArmed}>
          {!armed && <Plus size={16} aria-hidden />}
          {armed ? 'Cancel' : 'Place sign'}
        </button>
        <div className="chip-row" role="group" aria-label="Signs">
          {signs.map((sign, index) => (
            <button key={sign.id} className="chip" aria-pressed={sign.id === selectedId} onClick={() => setSelectedId(sign.id)}>
              Sign {index + 1}
            </button>
          ))}
        </div>
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
            <button className="signage-switch" role="switch" aria-checked={showMeasures} onClick={() => setShowMeasures(!showMeasures)}>
              <span aria-hidden />
              Measurements
            </button>
            <button className="circle signage-remove" aria-label="Remove this sign" onClick={() => void remove(selected.id)}>
              <Trash2 size={16} aria-hidden />
            </button>
          </div>

          <dl className="signage-readout">
            <Reading label="Width" value={formatLength(selected.sizeM.widthM)} />
            <Reading label="Height" value={formatLength(selected.sizeM.heightM)} />
            <Reading label="Area" value={reading ? `${reading.areaM2.toFixed(2)} m²` : '…'} />
            <Reading label="Bottom above ground" value={height(reading?.bottomAboveGroundM)} />
            <Reading label="Top above ground" value={height(reading?.topAboveGroundM)} />
            <Reading label="Lift" value={lift(reading)} />
          </dl>
        </>
      )}
    </>
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

const height = (metres: number | null | undefined) => (metres === undefined ? '…' : metres === null ? 'Ground not found' : formatLength(metres))

function lift(reading: Measured | null) {
  if (!reading) return '…'
  if (reading.lift) return `${reading.lift.label} · reaches ${reading.lift.workingHeightM.toFixed(1)} m`
  if (reading.topAboveGroundM === null) return 'Ground not found'
  return reading.topAboveGroundM <= 2 ? 'None needed, reachable from the ground' : 'No lift in the catalogue reaches it'
}

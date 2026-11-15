import { useEffect, useMemo, useRef, useState } from 'react'
import type { BuildingDetail, BuildingModel } from '../../../server/src/model/building.ts'
import type { RouteDetail, RouteResult as RouteAnswer } from '../../../server/src/ops/route/index.ts'
import type { RouteTarget } from '../../../server/src/ops/route/solve.ts'
import { DEFAULT_LOOK, Dollhouse, type Pick as StagePick } from '../dollhouse/index.ts'
import { OpStatus, useOp } from '../ToolPanel'
import type { PanelProps } from '../tools'
import { routeLayer } from './overlay.ts'
import './route.css'
import { confidenceBand, markUnder } from './trail.ts'

// The presets of route_solve's `payload`, wheelchair first. `custom` needs sizes, so the panel
// leaves it to the agent.
const PAYLOADS = [
  { name: 'wheelchair', label: 'Wheelchair' },
  { name: 'person', label: 'Person' },
  { name: 'pallet_jack', label: 'Pallet jack' },
  { name: 'scissor_lift', label: 'Scissor lift' },
  { name: 'grand_piano', label: 'Grand piano' },
] as const

type Payload = (typeof PAYLOADS)[number]['name']
type Solved = { result: RouteAnswer; detail: RouteDetail }
type Tooltip = { door: RouteDetail['doors'][number]; x: number; y: number }

// The Routing panel: click a floor and pick a payload, and a dot trail runs from the street to
// it with a tick or a cross on each door. Hover a door for its confidence. The pointer is read in
// the capture phase, before the canvas's own listener reports the hover.
export default function RoutePanel({ property }: PanelProps) {
  const building = useOp<unknown, BuildingDetail>('building_get', { propertyId: property.id }, { detail: true })
  if (building.status !== 'ready') return <OpStatus state={building} />
  const { building: model } = building.detail
  if (!model.storeys.some(({ spaces }) => spaces.length)) return <p className="panel-note">This building has no rooms to route through yet.</p>
  return <RouteView propertyId={property.id} building={model} />
}

function RouteView({ propertyId, building }: { propertyId: string; building: BuildingModel }) {
  const [target, setTarget] = useState<RouteTarget | null>(null)
  const [payload, setPayload] = useState<Payload>('wheelchair')
  const [storeyIndex, setStoreyIndex] = useState(() => building.storeys.find(({ spaces }) => spaces.length)?.index ?? 0)
  const [solved, setSolved] = useState<Solved | null>(null)
  const [tooltip, setTooltip] = useState<Tooltip | null>(null)
  const pointer = useRef({ x: 0, y: 0 })

  const detail = solved?.result.reachable ? solved.detail : null
  const visited = useMemo(() => [...new Set(detail?.trail.map(([, , index]) => index))], [detail])
  const drawn = useMemo(
    () =>
      detail && solved
        ? visited.map((index) => ({ index, ...routeLayer(detail, DEFAULT_LOOK, index, building.storeys.find((storey) => storey.index === index)?.elevationM ?? 0, solved.result.confidence ?? 0) }))
        : [],
    [detail, solved, visited, building],
  )
  const layers = useMemo(() => drawn.flatMap(({ layers }) => layers), [drawn])

  const onRoute = (next: Solved | null) => {
    setSolved(next)
    setTooltip(null)
    const first = next?.detail.trail[0]?.[2]
    if (first !== undefined) setStoreyIndex(first)
  }
  const onPick = ({ spaceId, at, storeyIndex }: StagePick) => setTarget(spaceId ? { spaceId } : { at, storeyIndex })
  const onHover = (pick: StagePick | null) => {
    const marks = pick ? drawn.find(({ index }) => index === pick.storeyIndex)?.marks : undefined
    const door = pick && marks ? markUnder(marks, pick.at, DEFAULT_LOOK) : null
    setTooltip(door && { door, ...pointer.current })
  }

  const next = visited[(visited.indexOf(storeyIndex) + 1) % visited.length]
  return (
    <div className="route-panel">
      <div className="route-controls">
        <label>
          <span>Payload</span>
          <select value={payload} onChange={(event) => setPayload(PAYLOADS.find(({ name }) => name === event.target.value)?.name ?? 'wheelchair')}>
            {PAYLOADS.map(({ name, label }) => (
              <option key={name} value={name}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div
        className="route-view"
        onPointerMoveCapture={(event) => {
          const box = event.currentTarget.getBoundingClientRect()
          pointer.current = { x: event.clientX - box.left, y: event.clientY - box.top }
        }}
      >
        <Dollhouse building={building} storeyIndex={storeyIndex} layers={layers} onPick={onPick} onHover={onHover} />
        {tooltip && (
          <div className="route-tooltip" style={{ left: tooltip.x, top: tooltip.y }} role="tooltip">
            <span className={`route-band ${confidenceBand(tooltip.door.confidence)}`}>{tooltip.door.confidence.toFixed(2)}</span>
            <span>Limited by {tooltip.door.limitedBy}</span>
          </div>
        )}
      </div>
      <div className="route-storeys" role="group" aria-label="Storey">
        {building.storeys.map(({ index, label }) => (
          <button key={index} type="button" aria-pressed={index === storeyIndex} className={visited.includes(index) ? 'on-route' : undefined} onClick={() => setStoreyIndex(index)}>
            {label}
          </button>
        ))}
        {visited.length > 1 && (
          <button type="button" className="route-next" onClick={() => setStoreyIndex(next)}>
            Next storey on route
          </button>
        )}
      </div>
      {target ? (
        <RouteResult key={JSON.stringify([target, payload])} propertyId={propertyId} target={target} payload={payload} onRoute={onRoute} />
      ) : (
        <p className="panel-note">Click a floor to see the way in.</p>
      )}
    </div>
  )
}

type RouteResultProps = { propertyId: string; target: RouteTarget; payload: Payload; onRoute: (solved: Solved | null) => void }

// Solves one route and shows its figures. The panel remounts it on each new target or payload,
// and it hands the route up so the dollhouse can draw it.
function RouteResult({ propertyId, target, payload, onRoute }: RouteResultProps) {
  const input = 'spaceId' in target ? { propertyId, target, payload } : { propertyId, target: { at: target.at }, storeyIndex: target.storeyIndex, payload }
  const route = useOp<RouteAnswer, RouteDetail>('route_solve', input, { detail: true })
  const ready = route.status === 'ready' ? route : null

  useEffect(() => {
    if (!ready) return
    onRoute({ result: ready.result, detail: ready.detail })
    return () => onRoute(null)
  }, [ready])

  if (!ready) return <OpStatus state={route} />
  const { result } = ready
  return (
    <>
      {result.reachable ? (
        <dl className="route-figures">
          <div>
            <dt>Length</dt>
            <dd>{result.lengthM?.toFixed(0)} m</dd>
          </div>
          <div>
            <dt>Doors</dt>
            <dd>{result.doorCount}</dd>
          </div>
          <div>
            <dt>Too tight</dt>
            <dd className={result.failCount ? 'route-bad' : undefined}>{result.failCount}</dd>
          </div>
        </dl>
      ) : (
        <p className="route-none">No way in for this payload</p>
      )}
      <ul className="route-assumptions">
        {result.assumptions.map((assumption) => (
          <li key={assumption}>{assumption}</li>
        ))}
      </ul>
    </>
  )
}

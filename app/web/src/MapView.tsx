import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import { Minus, Plus, Star } from 'lucide-react'
import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Property } from '../../shared/property'
import { scoreBand, type PinState, type Pins } from './pins'
import { pinLabel } from './property'

// MapLibre fetches tiles from a worker, where a relative URL has no origin to resolve against.
const STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    vexcel: { type: 'raster', tiles: [`${location.origin}/api/tiles/{z}/{x}/{y}`], tileSize: 256, maxzoom: 21 },
  },
  layers: [
    { id: 'fallback', type: 'background', paint: { 'background-color': '#3A3D36' } },
    { id: 'vexcel', type: 'raster', source: 'vexcel', paint: { 'raster-brightness-max': 0.88 } },
  ],
}

// MapLibre finds its worker beside its own module, which Vite's dependency bundling moves.
maplibregl.setWorkerUrl(workerUrl)

const LOS_ANGELES: [number, number] = [-118.33, 34.05]

type Props = {
  properties: Property[]
  selected: Property | null
  bearing: number
  frameRequest: number
  chatOpen: boolean
  pins: Pins
  onSelect: (id: string) => void
  onArrive: (id: string) => void
}

// The map owns the camera. It flies to `selected`, reports arrival through `onArrive`, turns to
// `bearing`, and frames `properties` whenever nothing is selected or `frameRequest` changes.
// `pins` colours each property's pin with Proppy's progress and score.
export function MapView({ properties, selected, bearing, frameRequest, chatOpen, pins: pinStates, onSelect, onArrive }: Props) {
  const container = useRef<HTMLDivElement>(null)
  const [map, setMap] = useState<maplibregl.Map | null>(null)
  const [heading, setHeading] = useState(0)
  const [pins, setPins] = useState<ReadonlyMap<string, maplibregl.Marker>>(new Map())
  const markers = useRef(new Map<string, maplibregl.Marker>())
  const framed = useRef(false)
  const lastBearing = useRef(bearing)
  const arrive = useEffectEvent(onArrive)
  const chatInset = useEffectEvent(() => (chatOpen ? 420 : 0))

  useEffect(() => {
    if (!container.current) return
    const m = new maplibregl.Map({
      container: container.current,
      style: STYLE,
      center: LOS_ANGELES,
      zoom: 10,
      maxZoom: 21,
      maxPitch: 70,
      attributionControl: false,
    })
    m.on('rotate', () => setHeading(m.getBearing()))
    setMap(m)
    return () => {
      m.remove()
      markers.current.clear()
      framed.current = false
      setMap(null)
      setPins(new Map())
    }
  }, [])

  useEffect(() => {
    if (!map) return
    const live = markers.current
    const ids = new Set(properties.map((p) => p.id))
    for (const [id, marker] of live) {
      if (ids.has(id)) continue
      marker.remove()
      live.delete(id)
    }
    for (const p of properties) {
      if (!live.has(p.id)) live.set(p.id, new maplibregl.Marker({ element: document.createElement('div') }).setLngLat([p.lon, p.lat]).addTo(map))
    }
    setPins(new Map(live))
  }, [map, properties])

  useEffect(() => {
    if (!selected) return
    const el = pins.get(selected.id)?.getElement()
    el?.style.setProperty('z-index', '2')
    return () => {
      el?.style.removeProperty('z-index')
    }
  }, [pins, selected])

  useEffect(() => {
    if (!map || selected || properties.length === 0) return
    const bounds = new maplibregl.LngLatBounds()
    for (const p of properties) bounds.extend([p.lon, p.lat])
    const camera = map.cameraForBounds(bounds, { padding: { top: 80, bottom: 80, left: 80, right: 80 + chatInset() }, maxZoom: 16 })
    if (!camera) return
    map.flyTo({ ...camera, pitch: 0, bearing: 0, duration: framed.current ? 1400 : 0, essential: true })
    framed.current = true
  }, [map, properties, selected, frameRequest])

  // Declared before the fly effect so a new selection's flight overrides this turn.
  useEffect(() => {
    if (!map || lastBearing.current === bearing) return
    lastBearing.current = bearing
    if (selected) map.easeTo({ bearing, duration: 700 })
  }, [map, bearing, selected])

  useEffect(() => {
    if (!map || !selected) return
    const id = selected.id
    map.flyTo({ center: [selected.lon, selected.lat], zoom: 19, pitch: 60, bearing: 0, duration: 2200, essential: true })
    const onMoveEnd = () => arrive(id)
    map.once('moveend', onMoveEnd)
    return () => {
      map.off('moveend', onMoveEnd)
    }
  }, [map, selected])

  return (
    <>
      <div ref={container} className="map" />
      {properties.map((p) => {
        const marker = pins.get(p.id)
        return marker && createPortal(<Pin property={p} selected={p.id === selected?.id} state={pinStates.get(p.id)} onSelect={() => onSelect(p.id)} />, marker.getElement(), p.id)
      })}
      <div className={`map-control surface-pill zoom-stack${chatOpen ? ' shifted' : ''}`}>
        <button aria-label="Zoom in" onClick={() => map?.zoomIn()}>
          <Plus size={16} />
        </button>
        <button aria-label="Zoom out" onClick={() => map?.zoomOut()}>
          <Minus size={16} />
        </button>
        <button aria-label="Face north" onClick={() => map?.resetNorthPitch()}>
          <Compass heading={heading} />
        </button>
      </div>
    </>
  )
}

const PIN_NOTE = { scoring: ', scoring', failed: ', not scored' }

// A pin shows one state at a time, so selection outranks Proppy's colour.
function pinClass(selected: boolean, state: PinState | undefined) {
  if (selected) return 'selected'
  if (!state) return ''
  return state.status === 'scored' ? `scored ${scoreBand(state.score)}` : state.status
}

function Pin({ property, selected, state, onSelect }: { property: Property; selected: boolean; state: PinState | undefined; onSelect: () => void }) {
  const label = pinLabel(property)
  const scored = state?.status === 'scored' ? `, scored ${Math.round(state.score)}` : state ? PIN_NOTE[state.status] : ''
  return (
    <button
      className={['pin', label ? '' : 'dot', pinClass(selected, state)].join(' ')}
      aria-label={`${property.name}${scored}`}
      title={`${property.name}${scored}`}
      onClick={(e) => {
        e.stopPropagation()
        onSelect()
      }}
    >
      {selected && <Star size={14} fill="currentColor" strokeWidth={0} />}
      {label}
    </button>
  )
}

function Compass({ heading }: { heading: number }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" style={{ transform: `rotate(${-heading}deg)` }} aria-hidden>
      <path d="M12 2 L16 12 L8 12 Z" fill="var(--compass)" />
      <path d="M12 22 L16 12 L8 12 Z" fill="currentColor" />
    </svg>
  )
}

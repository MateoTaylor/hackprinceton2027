import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import { Minus, Plus, Star } from 'lucide-react'
import { memo, useEffect, useEffectEvent, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Property } from '../../shared/property'
import { attachObliqueRig, type Rig } from './obliqueRig'
import { cancelPrefetch, prefetch, useObliques } from './obliques'
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
const CHAT_WIDTH = 420

type Props = {
  properties: Property[]
  selected: Property | null
  frameRequest: number
  chatOpen: boolean
  pins: Pins
  onSelect: (id: string) => void
}

// The map owns the camera. It swoops into `selected` and its angled photos, and frames `properties`
// whenever nothing is selected or `frameRequest` changes. `pins` colours each property's pin with
// Proppy's progress and score.
export function MapView({ properties, selected, frameRequest, chatOpen, pins: pinStates, onSelect }: Props) {
  const container = useRef<HTMLDivElement>(null)
  const [map, setMap] = useState<maplibregl.Map | null>(null)
  const [rig, setRig] = useState<Rig | null>(null)
  const [pins, setPins] = useState<ReadonlyMap<string, maplibregl.Marker>>(new Map())
  const markers = useRef(new Map<string, maplibregl.Marker>())
  const framed = useRef(false)
  const chatInset = chatOpen ? CHAT_WIDTH : 0
  const frameInset = useEffectEvent(() => chatInset)

  useEffect(() => {
    if (!container.current) return
    const m = new maplibregl.Map({
      container: container.current,
      style: STYLE,
      center: LOS_ANGELES,
      zoom: 10,
      maxZoom: 21,
      maxPitch: 70,
      // MapLibre would snap a heading within 7° of north back to north after each gesture, which
      // turns a photo shot slightly off north away from where it lines up.
      bearingSnap: 0,
      attributionControl: false,
    })
    let attached: Rig | null = null
    m.once('load', () => {
      attached = attachObliqueRig(m)
      setRig(attached)
    })
    setMap(m)
    return () => {
      attached?.detach()
      setRig(null)
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
    // A photo flight leaves its padding on the map, so the padding here replaces it rather than adding to it.
    const camera = map.cameraForBounds(bounds, { padding: { top: 80, bottom: 80, left: 80, right: 80 + frameInset() }, maxZoom: 16, absolutePadding: true })
    if (!camera) return
    map.flyTo({ ...camera, bearing: 0, duration: framed.current ? 1400 : 0, essential: true })
    framed.current = true
  }, [map, properties, selected, frameRequest])

  return (
    <>
      <div ref={container} className="map" />
      <RigFeed rig={rig} subject={selected} chatInset={chatInset} />
      {properties.map((p) => {
        const marker = pins.get(p.id)
        return marker && createPortal(<Pin property={p} selected={p.id === selected?.id} state={pinStates.get(p.id)} onSelect={onSelect} />, marker.getElement(), p.id)
      })}
      <Compass map={map} onClick={() => rig?.faceNorth()} />
      <div className={`map-control surface-pill zoom-stack${chatOpen ? ' shifted' : ''}`}>
        <button aria-label="Zoom in" onClick={(e) => map?.zoomIn({}, { originalEvent: e.nativeEvent })}>
          <Plus size={16} />
        </button>
        <button aria-label="Zoom out" onClick={(e) => map?.zoomOut({}, { originalEvent: e.nativeEvent })}>
          <Minus size={16} />
        </button>
      </div>
    </>
  )
}

// Hands the rig the selected property and its photos. It renders nothing, so a photo arriving
// re-renders only this.
function RigFeed({ rig, subject, chatInset }: { rig: Rig | null; subject: Property | null; chatInset: number }) {
  const obliques = useObliques(subject?.id ?? null)
  const id = subject?.id
  const lon = subject?.lon
  const lat = subject?.lat
  useEffect(() => {
    rig?.update({ subject: id && lon !== undefined && lat !== undefined ? { id, lngLat: [lon, lat] } : null, obliques, chatInset })
  }, [rig, id, lon, lat, obliques, chatInset])
  return null
}

// Shows which way the camera looks. The needle and label follow the map itself, so turning
// re-renders nothing.
function Compass({ map, onClick }: { map: maplibregl.Map | null; onClick: () => void }) {
  const button = useRef<HTMLButtonElement>(null)
  const needle = useRef<SVGSVGElement>(null)
  useEffect(() => {
    if (!map) return
    const turn = () => {
      const bearing = map.getBearing()
      needle.current?.style.setProperty('rotate', `${-bearing}deg`)
      button.current?.setAttribute('aria-label', `Facing ${(Math.round(bearing) + 360) % 360}°, face north`)
    }
    turn()
    map.on('rotate', turn)
    return () => {
      map.off('rotate', turn)
    }
  }, [map])
  return (
    <button ref={button} className="map-control surface-pill compass" aria-label="Face north" title="Face north" onClick={onClick}>
      <svg ref={needle} width="16" height="24" viewBox="0 0 16 24" aria-hidden="true">
        <path d="M8 0 15 12H1Z" fill="var(--compass)" />
        <path d="M8 24 1 12h14Z" fill="var(--color-text-muted)" />
      </svg>
    </button>
  )
}

const PIN_NOTE = { scoring: ', scoring', failed: ', not scored' }

// A pin shows one state at a time, so selection outranks Proppy's colour.
function pinClass(selected: boolean, state: PinState | undefined) {
  if (selected) return 'selected'
  if (!state) return ''
  return state.status === 'scored' ? `scored ${scoreBand(state.score)}` : state.status
}

type PinProps = { property: Property; selected: boolean; state: PinState | undefined; onSelect: (id: string) => void }

// Memoized, so a photo arriving or a selection changing re-renders only the pins it touches.
const Pin = memo(function Pin({ property, selected, state, onSelect }: PinProps) {
  const label = pinLabel(property)
  const scored = state?.status === 'scored' ? `, scored ${Math.round(state.score)}` : state ? PIN_NOTE[state.status] : ''
  return (
    <button
      className={['pin', label ? '' : 'dot', pinClass(selected, state)].join(' ')}
      aria-label={`${property.name}${scored}`}
      title={`${property.name}${scored}`}
      onPointerEnter={() => prefetch(property.id)}
      onPointerLeave={cancelPrefetch}
      onClick={(e) => {
        e.stopPropagation()
        onSelect(property.id)
      }}
    >
      {selected && <Star size={14} fill="currentColor" strokeWidth={0} />}
      {label}
    </button>
  )
})

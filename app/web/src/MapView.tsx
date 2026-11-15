import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import { Minus, Plus, Star } from 'lucide-react'
import { memo, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Property } from '../../shared/property'
import type { Bounds, Camera } from '../../shared/view'
import { attachObliqueRig, type Rig } from './obliqueRig'
import { cancelPrefetch, prefetch, useObliques } from './obliques'
import { scoreBand, type PinState, type Pins } from './pins'
import { pinLabel } from './property'
import type { MoveRequest } from './view'

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
const FIT_MAX_ZOOM = 17
// Keeps a framed pin's centre clear of the map controls and the floating Proppy button: 20px edge,
// a 40px control, a 12px gap and half of a wide price pin.
const FIT_PADDING = { top: 96, bottom: 96, left: 128, right: 128 }

type Props = {
  properties: Property[]
  all: Property[]
  selected: Property | null
  move: MoveRequest | null
  chatOpen: boolean
  pins: Pins
  onSelect: (id: string) => void
  onCamera: (camera: Camera, bounds: Bounds) => void
}

// The map owns the camera. It swoops into `selected` and its angled photos, and frames `properties`
// whenever nothing is selected. A property in `pins` keeps its pin from `all` even when `properties`
// leaves it out, but framing ignores it. It applies each `move` once, after that framing, and reports the
// camera it reached through `onCamera` after every move. `pins` colours each property's pin.
export function MapView({ properties, all, selected, move, chatOpen, pins: pinStates, onSelect, onCamera }: Props) {
  const container = useRef<HTMLDivElement>(null)
  const [map, setMap] = useState<maplibregl.Map | null>(null)
  const [rig, setRig] = useState<Rig | null>(null)
  const [pins, setPins] = useState<ReadonlyMap<string, maplibregl.Marker>>(new Map())
  const markers = useRef(new Map<string, maplibregl.Marker>())
  const framed = useRef(false)
  const chatInset = chatOpen ? CHAT_WIDTH : 0
  const fitPadding = useEffectEvent(() => ({ ...FIT_PADDING, right: FIT_PADDING.right + chatInset }))
  const shown = useMemo(() => {
    const ids = new Set(properties.map((p) => p.id))
    const held = all.filter((p) => pinStates.has(p.id) && !ids.has(p.id))
    return held.length === 0 ? properties : [...properties, ...held]
  }, [properties, all, pinStates])
  const applied = useRef(0)
  const reportCamera = useEffectEvent((m: maplibregl.Map) => {
    const { lat, lng } = m.getCenter()
    const b = m.getBounds()
    onCamera({ lat, lon: lng, zoom: m.getZoom() }, { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() })
  })

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
    m.on('moveend', () => reportCamera(m))
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
    const ids = new Set(shown.map((p) => p.id))
    for (const [id, marker] of live) {
      if (ids.has(id)) continue
      marker.remove()
      live.delete(id)
    }
    for (const p of shown) {
      if (!live.has(p.id)) live.set(p.id, new maplibregl.Marker({ element: document.createElement('div') }).setLngLat([p.lon, p.lat]).addTo(map))
    }
    setPins(new Map(live))
  }, [map, shown])

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
    const camera = map.cameraForBounds(bounds, { padding: fitPadding(), maxZoom: 16, absolutePadding: true })
    if (!camera) return
    map.flyTo({ ...camera, bearing: 0, duration: framed.current ? 1400 : 0, essential: true })
    framed.current = true
  }, [map, properties, selected])

  useEffect(() => {
    if (!map || !move || move.seq === applied.current) return
    applied.current = move.seq
    const { request } = move
    if ('fit' in request) {
      const { west, south, east, north } = request.fit
      const camera = map.cameraForBounds([west, south, east, north], { padding: fitPadding(), maxZoom: FIT_MAX_ZOOM, absolutePadding: true })
      if (camera) map.flyTo({ ...camera, bearing: 0, duration: 1400, essential: true })
    } else {
      map.easeTo({ center: [request.lon, request.lat], zoom: request.zoom, duration: 1200, essential: true })
    }
  }, [map, move])

  return (
    <>
      <div ref={container} className="map" />
      <RigFeed rig={rig} subject={selected} chatInset={chatInset} />
      {shown.map((p) => {
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

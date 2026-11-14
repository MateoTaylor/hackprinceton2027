import { useEffect, useMemo, useRef, useState } from 'react'
import type { PropertyKind } from '../../shared/property'
import type { Direction } from '../../shared/api'
import { BEARING, fetchObliqueDirections, fetchProperties, obliqueUrl } from './api'
import { FlyThrough } from './FlyThrough'
import { Header } from './Header'
import { MapView } from './MapView'
import { ObliqueControls, ObliquePhoto, type Oblique } from './Oblique'
import { NO_PINS, type Pins } from './pins'
import { SORTS, type SortKey } from './property'
import { Proppy } from './Proppy'
import { QuickView } from './QuickView'
import { Sidebar, type Listing } from './Sidebar'

type View =
  | { kind: 'browse' }
  | { kind: 'selected'; id: string; oblique: Oblique }
  | { kind: 'flythrough'; id: string; oblique: Oblique; modelId: string }

const BROWSE: View = { kind: 'browse' }

export function App() {
  const [listing, setListing] = useState<Listing>({ status: 'loading' })
  const [reload, setReload] = useState(0)
  const [view, setView] = useState<View>(BROWSE)
  const [kind, setKind] = useState<PropertyKind | null>(null)
  const [type, setType] = useState<string | null>(null)
  const [sort, setSort] = useState<SortKey>('name')
  const [saved, setSaved] = useState<ReadonlySet<string>>(new Set())
  const [savedOnly, setSavedOnly] = useState(false)
  const [proppyOpen, setProppyOpen] = useState(false)
  const [frameRequest, setFrameRequest] = useState(0)
  const [pins, setPins] = useState<Pins>(NO_PINS)
  const obliqueRequest = useRef<AbortController | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    setListing({ status: 'loading' })
    fetchProperties(controller.signal).then(
      (properties) => setListing({ status: 'ready', properties }),
      (e: unknown) => controller.signal.aborted || setListing({ status: 'error', message: e instanceof Error ? e.message : String(e) }),
    )
    return () => controller.abort()
  }, [reload])

  const all = listing.status === 'ready' ? listing.properties : []
  const types = useMemo(() => [...new Set(all.map((p) => p.typeLabel))].sort(), [all])
  const visible = useMemo(
    () =>
      all
        .filter((p) => (!kind || p.kind === kind) && (!type || p.typeLabel === type) && (!savedOnly || saved.has(p.id)))
        .sort(SORTS[sort].compare),
    [all, kind, type, savedOnly, saved, sort],
  )

  const selected = view.kind === 'browse' ? null : (all.find((p) => p.id === view.id) ?? null)
  const oblique = view.kind === 'browse' ? null : view.oblique
  const dir = oblique?.status === 'ready' ? oblique.dir : null

  const setOblique = (id: string, next: Oblique) =>
    setView((v) => (v.kind !== 'browse' && v.id === id ? { ...v, oblique: next } : v))

  // Picking the property already shown changes nothing; the camera is already there.
  const select = (id: string) => {
    if (view.kind !== 'browse' && view.id === id) return
    obliqueRequest.current?.abort()
    setView({ kind: 'selected', id, oblique: { status: 'flying' } })
  }

  // Oblique photos wait for the camera to land, so the flight is never covered by a still.
  const arrive = (id: string) => {
    obliqueRequest.current?.abort()
    const controller = new AbortController()
    obliqueRequest.current = controller
    setOblique(id, { status: 'loading' })
    fetchObliqueDirections(id, controller.signal).then(
      (directions) =>
        setOblique(id, directions.length ? { status: 'ready', directions, dir: directions.includes('north') ? 'north' : directions[0] } : { status: 'none' }),
      () => controller.signal.aborted || setOblique(id, { status: 'error' }),
    )
  }

  const pickDir = (next: Direction | null) =>
    setView((v) => (v.kind !== 'browse' && v.oblique.status === 'ready' ? { ...v, oblique: { ...v.oblique, dir: next } } : v))

  const toggleSaved = (id: string) =>
    setSaved((s) => {
      const next = new Set(s)
      if (!next.delete(id)) next.add(id)
      return next
    })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const target = e.target
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable)) return
      setView((v) => (v.kind === 'flythrough' ? { kind: 'selected', id: v.id, oblique: v.oblique } : BROWSE))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="app">
      <Header
        types={types}
        type={type}
        onType={setType}
        sort={sort}
        onSort={setSort}
        onFrame={() => {
          setView(BROWSE)
          setFrameRequest((n) => n + 1)
        }}
        savedCount={saved.size}
        savedOnly={savedOnly}
        onSavedOnly={setSavedOnly}
      />
      <div className="body">
        <Sidebar
          listing={listing}
          visible={visible}
          selectedId={selected?.id ?? null}
          onSelect={select}
          kind={kind}
          onKind={setKind}
          saved={saved}
          onToggleSaved={toggleSaved}
          onRetry={() => setReload((n) => n + 1)}
          onClearFilters={() => {
            setKind(null)
            setType(null)
            setSavedOnly(false)
          }}
        />
        <main className="map-frame">
          <MapView
            properties={visible}
            selected={selected}
            bearing={dir ? BEARING[dir] : 0}
            frameRequest={frameRequest}
            chatOpen={proppyOpen}
            pins={pins}
            onSelect={select}
            onArrive={arrive}
          />
          {selected && <ObliquePhoto key={selected.id} src={dir && obliqueUrl(selected.id, dir)} />}
          <ObliqueControls oblique={oblique} onDir={pickDir} />
          <div className={`map-control attribution${selected ? ' pill' : ''}`}>Imagery © Vexcel · Data © CoStar</div>
          {selected && view.kind === 'selected' && (
            <QuickView
              property={selected}
              saved={saved.has(selected.id)}
              onToggleSaved={() => toggleSaved(selected.id)}
              onClose={() => setView(BROWSE)}
              onFlyThrough={() => setView({ kind: 'flythrough', id: selected.id, oblique: view.oblique, modelId: selected.scans[0].modelId })}
            />
          )}
          {selected && view.kind === 'flythrough' && (
            <FlyThrough
              property={selected}
              modelId={view.modelId}
              onModel={(modelId) => setView({ ...view, modelId })}
              onClose={() => setView({ kind: 'selected', id: view.id, oblique: view.oblique })}
            />
          )}
          <Proppy open={proppyOpen} onOpen={() => setProppyOpen(true)} onClose={() => setProppyOpen(false)} onPins={setPins} />
        </main>
      </div>
    </div>
  )
}

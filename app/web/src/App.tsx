import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Property, PropertyKind } from '../../shared/property'
import type { Bounds, Screen } from '../../shared/view'
import { fetchProperties } from './api'
import { matches, NO_FACETS, type Facets } from './filter'
import { FlyThrough } from './FlyThrough'
import { Header } from './Header'
import { MapView } from './MapView'
import { pinsFromHighlights } from './pins'
import { SORTS, type SortKey } from './property'
import { Proppy } from './Proppy'
import { QuickView } from './QuickView'
import { Sidebar, type Listing } from './Sidebar'
import { ToolPanel } from './ToolPanel'
import { toolsFor } from './tools'
import { useView } from './view'

const BROWSE: Screen = { kind: 'browse' }

export function App() {
  const [listing, setListing] = useState<Listing>({ status: 'loading' })
  const [reload, setReload] = useState(0)
  const { view, setScreen, report, move, requestMove } = useView()
  const { screen } = view
  const [kind, setKind] = useState<PropertyKind | null>(null)
  const [type, setType] = useState<string | null>(null)
  const [sort, setSort] = useState<SortKey>('name')
  const [saved, setSaved] = useState<ReadonlySet<string>>(new Set())
  const [savedOnly, setSavedOnly] = useState(false)
  const [query, setQuery] = useState('')
  const [facets, setFacets] = useState<Facets>(NO_FACETS)
  const [proppyOpen, setProppyOpen] = useState(false)
  const [proppyRunning, setProppyRunning] = useState(false)

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
        .filter((p) => matches(p, { query, kind, type, savedOnly, saved, facets }))
        .sort(SORTS[sort].compare),
    [all, query, kind, type, savedOnly, saved, facets, sort],
  )

  const selected = screen.kind === 'browse' ? null : (all.find((p) => p.id === screen.propertyId) ?? null)

  const tool = selected && screen.kind === 'tool' ? toolsFor(selected).find((t) => t.id === screen.tool) : undefined

  const select = useCallback(
    (propertyId: string) => {
      if (screen.kind !== 'browse' && screen.propertyId === propertyId) return
      setScreen(screen.kind === 'tool' ? { ...screen, propertyId } : { kind: 'selected', propertyId })
    },
    [screen, setScreen],
  )

  useEffect(() => report({ filter: { kind, type, sort, savedOnly } }), [report, kind, type, sort, savedOnly])
  useEffect(() => {
    if (listing.status === 'ready') report({ shown: visible.map((p) => p.id) })
  }, [report, listing.status, visible])

  const shownPins = useMemo(() => pinsFromHighlights(view.highlights, proppyRunning), [view.highlights, proppyRunning])

  const toggleSaved = useCallback(
    (id: string) =>
      setSaved((s) => {
        const next = new Set(s)
        if (!next.delete(id)) next.add(id)
        return next
      }),
    [],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const target = e.target
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable)) return
      setScreen(screen.kind === 'flythrough' || screen.kind === 'tool' ? { kind: 'selected', propertyId: screen.propertyId } : BROWSE)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [screen, setScreen])

  return (
    <div className="app">
      <Header
        query={query}
        onQuery={setQuery}
        types={types}
        type={type}
        onType={setType}
        sort={sort}
        onSort={setSort}
        kind={kind}
        onKind={setKind}
        facets={facets}
        onFacets={setFacets}
        onFrame={() => {
          setScreen(BROWSE)
          const fit = boundsOf(visible)
          if (fit) requestMove({ fit })
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
          saved={saved}
          onToggleSaved={toggleSaved}
          onRetry={() => setReload((n) => n + 1)}
          onClearFilters={() => {
            setQuery('')
            setFacets(NO_FACETS)
            setKind(null)
            setType(null)
            setSavedOnly(false)
          }}
        />
        <main className="map-frame">
          <MapView
            properties={visible}
            all={all}
            selected={selected}
            move={move}
            chatOpen={proppyOpen}
            pins={shownPins}
            onSelect={select}
            onCamera={(camera, bounds) => report({ camera, bounds })}
          />
          <div className={`map-control attribution${selected ? ' pill' : ''}`}>Imagery © Vexcel · Data © CoStar</div>
          {selected && (screen.kind === 'selected' || (screen.kind === 'tool' && !tool)) && (
            <QuickView
              property={selected}
              saved={saved.has(selected.id)}
              onToggleSaved={() => toggleSaved(selected.id)}
              onClose={() => setScreen(BROWSE)}
              onFlyThrough={() => setScreen({ kind: 'flythrough', propertyId: selected.id, modelId: selected.scans[0].modelId })}
              onTool={(toolId) => setScreen({ kind: 'tool', propertyId: selected.id, tool: toolId })}
            />
          )}
          {selected && screen.kind === 'flythrough' && (
            <FlyThrough
              property={selected}
              modelId={screen.modelId}
              onModel={(modelId) => setScreen({ ...screen, modelId })}
              onClose={() => setScreen({ kind: 'selected', propertyId: screen.propertyId })}
            />
          )}
          <Proppy open={proppyOpen} onOpen={() => setProppyOpen(true)} onClose={() => setProppyOpen(false)} onRunning={setProppyRunning} />
          {selected && tool && <ToolPanel tool={tool} property={selected} onClose={() => setScreen({ kind: 'selected', propertyId: selected.id })} />}
        </main>
      </div>
    </div>
  )
}

// The box around `properties`, or null when there are none.
function boundsOf(properties: readonly Property[]): Bounds | null {
  if (properties.length === 0) return null
  const lats = properties.map((p) => p.lat)
  const lons = properties.map((p) => p.lon)
  return { west: Math.min(...lons), south: Math.min(...lats), east: Math.max(...lons), north: Math.max(...lats) }
}

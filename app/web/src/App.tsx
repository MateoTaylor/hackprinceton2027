import { useCallback, useEffect, useMemo, useState } from 'react'
import type { PropertyKind } from '../../shared/property'
import { fetchProperties } from './api'
import { FlyThrough } from './FlyThrough'
import { Header } from './Header'
import { MapView } from './MapView'
import { NO_PINS, type Pins } from './pins'
import { SORTS, type SortKey } from './property'
import { Proppy } from './Proppy'
import { QuickView } from './QuickView'
import { Sidebar, type Listing } from './Sidebar'
import { ToolPanel } from './ToolPanel'
import { toolsFor, type ToolId } from './tools'

type View =
  | { kind: 'browse' }
  | { kind: 'selected'; id: string }
  | { kind: 'flythrough'; id: string; modelId: string }
  | { kind: 'tool'; id: string; tool: ToolId }

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

  const tool = selected && view.kind === 'tool' ? toolsFor(selected).find((t) => t.id === view.tool) : undefined

  const select = useCallback(
    (id: string) =>
      setView((v) => {
        if (v.kind !== 'browse' && v.id === id) return v
        return v.kind === 'tool' ? { ...v, id } : { kind: 'selected', id }
      }),
    [],
  )

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
      setView((v) => (v.kind === 'flythrough' || v.kind === 'tool' ? { kind: 'selected', id: v.id } : BROWSE))
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
            frameRequest={frameRequest}
            chatOpen={proppyOpen}
            pins={pins}
            onSelect={select}
          />
          <div className={`map-control attribution${selected ? ' pill' : ''}`}>Imagery © Vexcel · Data © CoStar</div>
          {selected && (view.kind === 'selected' || (view.kind === 'tool' && !tool)) && (
            <QuickView
              property={selected}
              saved={saved.has(selected.id)}
              onToggleSaved={() => toggleSaved(selected.id)}
              onClose={() => setView(BROWSE)}
              onFlyThrough={() => setView({ kind: 'flythrough', id: selected.id, modelId: selected.scans[0].modelId })}
              onTool={(toolId) => setView({ kind: 'tool', id: selected.id, tool: toolId })}
            />
          )}
          {selected && view.kind === 'flythrough' && (
            <FlyThrough
              property={selected}
              modelId={view.modelId}
              onModel={(modelId) => setView({ ...view, modelId })}
              onClose={() => setView({ kind: 'selected', id: view.id })}
            />
          )}
          <Proppy open={proppyOpen} onOpen={() => setProppyOpen(true)} onClose={() => setProppyOpen(false)} onPins={setPins} />
          {selected && tool && <ToolPanel tool={tool} property={selected} onClose={() => setView({ kind: 'selected', id: selected.id })} />}
        </main>
      </div>
    </div>
  )
}

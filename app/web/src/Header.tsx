import { Bookmark, Menu, Search, SlidersHorizontal, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { PropertyKind } from '../../shared/property'
import costarLogo from './assets/costar-logo.svg'
import { FACET_KEYS, FACETS, NO_FACETS, type Facets } from './filter'
import { isSortKey, SORTS, type SortKey } from './property'

const KINDS: { kind: PropertyKind | null; label: string }[] = [
  { kind: null, label: 'All' },
  { kind: 'commercial', label: 'Commercial' },
  { kind: 'residential', label: 'Residential' },
]

type Props = {
  query: string
  onQuery: (query: string) => void
  types: string[]
  type: string | null
  onType: (type: string | null) => void
  sort: SortKey
  onSort: (sort: SortKey) => void
  kind: PropertyKind | null
  onKind: (kind: PropertyKind | null) => void
  facets: Facets
  onFacets: (facets: Facets) => void
  onFrame: () => void
  savedCount: number
  savedOnly: boolean
  onSavedOnly: (savedOnly: boolean) => void
}

export function Header({ query, onQuery, types, type, onType, sort, onSort, kind, onKind, facets, onFacets, onFrame, savedCount, savedOnly, onSavedOnly }: Props) {
  return (
    <header className="header">
      <div className="header-slot">
        <div className="logo">
          <span className="wordmark">propstar</span>
          <span className="byline">
            by <img src={costarLogo} width={47} height={13} alt="CoStar" />
          </span>
        </div>
      </div>

      <div className="filter-pill">
        <label className="segment query">
          <Search size={14} className="muted" aria-hidden />
          <input
            type="text"
            role="searchbox"
            aria-label="Search by name, address or type"
            placeholder="Search LA"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onQuery('')
              if (e.key === 'Enter') onFrame()
            }}
          />
          {query && (
            <button className="clear" aria-label="Clear search" onClick={() => onQuery('')}>
              <X size={12} />
            </button>
          )}
        </label>
        <span className="divider" />
        <select className="segment type" aria-label="Property type" value={type ?? ''} onChange={(e) => onType(e.target.value || null)}>
          <option value="">Any type</option>
          {types.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <span className="divider" />
        <select className="segment sort" aria-label="Sort" value={sort} onChange={(e) => isSortKey(e.target.value) && onSort(e.target.value)}>
          {Object.entries(SORTS).map(([key, { label }]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
        <FilterMenu kind={kind} onKind={onKind} facets={facets} onFacets={onFacets} />
      </div>

      <div className="header-slot end">
        <button className="header-pill" aria-pressed={savedOnly} onClick={() => onSavedOnly(!savedOnly)}>
          <Bookmark size={14} className={savedOnly ? undefined : 'muted'} />
          Saved{savedCount > 0 ? ` · ${savedCount}` : ''}
        </button>
        <div className="header-pill account" aria-hidden>
          <Menu size={16} />
          <span className="avatar">FM</span>
        </div>
      </div>
    </header>
  )
}

type FilterMenuProps = Pick<Props, 'kind' | 'onKind' | 'facets' | 'onFacets'>

// The round filter button at the end of the header pill and the panel it opens: property kind and
// one band per facet. Clicking a chosen band again clears it. The button shows how many are set.
function FilterMenu({ kind, onKind, facets, onFacets }: FilterMenuProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const active = (kind ? 1 : 0) + FACET_KEYS.filter((key) => facets[key] !== null).length

  useEffect(() => {
    if (!open) return
    const onPointer = (e: PointerEvent) => e.target instanceof Node && !ref.current?.contains(e.target) && setOpen(false)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="filter-menu" ref={ref}>
      <button className="circle filters" aria-label="Filters" aria-expanded={open} onClick={() => setOpen(!open)}>
        <SlidersHorizontal size={16} />
        {active > 0 && <span className="filter-count">{active}</span>}
      </button>
      {open && (
        <div className="filter-panel" role="dialog" aria-label="Filters">
          <div className="filter-group">
            <span className="filter-label">Kind</span>
            <div className="chip-row">
              {KINDS.map((k) => (
                <button key={k.label} className="chip" aria-pressed={kind === k.kind} onClick={() => onKind(k.kind)}>
                  {k.label}
                </button>
              ))}
            </div>
          </div>
          {FACET_KEYS.map((key) => (
            <div key={key} className="filter-group">
              <span className="filter-label">{FACETS[key].label}</span>
              <div className="chip-row">
                {FACETS[key].bands.map((band, i) => (
                  <button
                    key={band.label}
                    className="chip"
                    aria-pressed={facets[key] === i}
                    onClick={() => onFacets({ ...facets, [key]: facets[key] === i ? null : i })}
                  >
                    {band.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
          {active > 0 && (
            <button
              className="button quiet filter-clear"
              onClick={() => {
                onKind(null)
                onFacets(NO_FACETS)
              }}
            >
              Clear filters
            </button>
          )}
        </div>
      )}
    </div>
  )
}

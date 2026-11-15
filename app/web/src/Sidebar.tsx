import { Bookmark, Box, Search, X } from 'lucide-react'
import { memo, useEffect, useRef } from 'react'
import type { Property, PropertyKind } from '../../shared/property'
import { FACET_KEYS, FACETS, type Facets } from './filter'
import { metaLine, specLine } from './property'
import { cancelPrefetch, prefetch } from './obliques'
import { PropertyPhoto } from './PropertyPhoto'

export type Listing = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; properties: Property[] }

const KINDS: { kind: PropertyKind | null; label: string }[] = [
  { kind: null, label: 'All' },
  { kind: 'commercial', label: 'Commercial' },
  { kind: 'residential', label: 'Residential' },
]

// Options render in the OS menu, so they need the surface colours even when the chip is inverted.
const OPTION = { background: 'var(--color-surface)', color: 'var(--color-text)' }

type Props = {
  listing: Listing
  visible: Property[]
  selectedId: string | null
  onSelect: (id: string) => void
  kind: PropertyKind | null
  onKind: (kind: PropertyKind | null) => void
  query: string
  onQuery: (query: string) => void
  facets: Facets
  onFacets: (facets: Facets) => void
  saved: ReadonlySet<string>
  onToggleSaved: (id: string) => void
  onRetry: () => void
  onClearFilters: () => void
}

export function Sidebar({ listing, visible, selectedId, onSelect, kind, onKind, query, onQuery, facets, onFacets, saved, onToggleSaved, onRetry, onClearFilters }: Props) {
  const title =
    listing.status === 'ready' ? `${visible.length} ${visible.length === 1 ? 'property' : 'properties'}` : 'Properties'

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <h1 className="sidebar-title">{title}</h1>
        <label className="composer-input" style={{ height: 40, paddingRight: 4 }}>
          <Search size={16} className="muted" aria-hidden />
          <input
            type="text"
            role="searchbox"
            aria-label="Search by name, address or type"
            placeholder="Search name, address or type"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && onQuery('')}
          />
          {query && (
            <button className="circle" style={{ width: 32, height: 32 }} aria-label="Clear search" onClick={() => onQuery('')}>
              <X size={14} />
            </button>
          )}
        </label>
        <div className="chip-row">
          {KINDS.map((k) => (
            <button key={k.label} className="chip" aria-pressed={kind === k.kind} onClick={() => onKind(k.kind)}>
              {k.label}
            </button>
          ))}
        </div>
        <div className="chip-row">
          {FACET_KEYS.map((key) => {
            const facet = FACETS[key]
            const index = facets[key]
            return (
              <select
                key={key}
                className="chip"
                style={{ appearance: 'none', border: 0, cursor: 'pointer', ...(index !== null && { background: 'var(--color-text)', color: 'var(--color-bg)' }) }}
                aria-label={facet.label}
                value={index ?? ''}
                onChange={(e) => onFacets({ ...facets, [key]: e.target.value === '' ? null : Number(e.target.value) })}
              >
                <option value="" style={OPTION}>
                  {facet.any}
                </option>
                {facet.bands.map((band, i) => (
                  <option key={band.label} value={i} style={OPTION}>
                    {band.label}
                  </option>
                ))}
              </select>
            )
          })}
        </div>
      </div>

      {listing.status === 'loading' && (
        <div className="card-grid" aria-busy>
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="card">
              <div className="card-image skeleton" />
              <div className="skeleton line" style={{ width: '70%' }} />
              <div className="skeleton line" style={{ width: '45%' }} />
            </div>
          ))}
        </div>
      )}

      {listing.status === 'error' && (
        <div className="list-state">
          <span>The property list did not load. {listing.message}.</span>
          <button className="button quiet" onClick={onRetry}>
            Try again
          </button>
        </div>
      )}

      {listing.status === 'ready' && visible.length === 0 && (
        <div className="list-state">
          <span>No properties match these filters.</span>
          <button className="button quiet" onClick={onClearFilters}>
            Clear filters
          </button>
        </div>
      )}

      {listing.status === 'ready' && visible.length > 0 && (
        <div className="card-grid">
          {visible.map((p) => (
            <Card
              key={p.id}
              property={p}
              selected={p.id === selectedId}
              saved={saved.has(p.id)}
              onSelect={onSelect}
              onToggleSaved={onToggleSaved}
            />
          ))}
        </div>
      )}
    </aside>
  )
}

type CardProps = { property: Property; selected: boolean; saved: boolean; onSelect: (id: string) => void; onToggleSaved: (id: string) => void }

// Memoized, so selecting a property re-renders only the two cards whose selection changed.
const Card = memo(function Card({ property, selected, saved, onSelect, onToggleSaved }: CardProps) {
  const ref = useRef<HTMLDivElement>(null)

  // A pin click selects a card that may be scrolled out of view.
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [selected])

  return (
    <div
      ref={ref}
      className="card"
      role="button"
      tabIndex={0}
      aria-current={selected}
      onClick={() => onSelect(property.id)}
      onPointerEnter={() => prefetch(property.id)}
      onPointerLeave={cancelPrefetch}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return
        e.preventDefault()
        onSelect(property.id)
      }}
    >
      <div className="card-image">
        <PropertyPhoto property={property} />
        <button
          className="circle overlay save"
          aria-label={saved ? 'Remove from saved' : 'Save'}
          aria-pressed={saved}
          onClick={(e) => {
            e.stopPropagation()
            onToggleSaved(property.id)
          }}
        >
          <Bookmark size={16} fill={saved ? 'currentColor' : 'none'} />
        </button>
        {property.scans.length > 0 && (
          <span className="circle overlay scan-badge" title={`${property.scans.length} 3D scan${property.scans.length === 1 ? '' : 's'}`}>
            <Box size={12} />
          </span>
        )}
      </div>
      <div className="card-text">
        <span className="card-name">{property.name}</span>
        <span className="card-spec">{specLine(property) || property.typeLabel}</span>
        <span className="card-meta">{metaLine(property)}</span>
      </div>
    </div>
  )
})

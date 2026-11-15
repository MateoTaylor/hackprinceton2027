import { Bookmark, X } from 'lucide-react'
import type { Property } from '../../shared/property'
import { fact } from './property'
import { PropertyPhoto } from './PropertyPhoto'
import { toolsFor, type ToolId } from './tools'

type Props = {
  property: Property
  saved: boolean
  onToggleSaved: () => void
  onClose: () => void
  onFlyThrough: () => void
  onTool: (id: ToolId) => void
}

// Bare numbers need their label to read; formatted values like "12,345 SF" carry their own.
const LABELLED = new Set(['Year built', 'Stories', 'Beds', 'Baths', 'Units', 'Rooms'])

const stars = (p: Property) => fact(p, 'Rating')?.replace(/ stars?$/, '★')

export function QuickView({ property, saved, onToggleSaved, onClose, onFlyThrough, onTool }: Props) {
  const classLine =
    property.kind === 'commercial'
      ? [fact(property, 'Class') && `Class ${fact(property, 'Class')}`, stars(property)].filter(Boolean).join(' · ') || property.typeLabel
      : property.typeLabel
  const factsLine = property.facts
    .slice(0, 3)
    .map((f) => (LABELLED.has(f.label) ? `${f.label} ${f.value}` : f.value))
    .join(' · ')
  const scanCount = property.scans.length

  return (
    <section className="quick-view" aria-label={property.name}>
      <div className="quick-photo">
        <PropertyPhoto key={property.id} property={property} />
        <div className="quick-buttons">
          <button className="circle overlay" aria-label={saved ? 'Remove from saved' : 'Save'} aria-pressed={saved} onClick={onToggleSaved}>
            <Bookmark size={16} fill={saved ? 'currentColor' : 'none'} />
          </button>
          <button className="circle overlay" aria-label="Close" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
      </div>
      <div className="quick-info">
        <div className="quick-title">
          <span className="quick-name">{property.name}</span>
          <span className="quick-class">{classLine}</span>
        </div>
        <span className="quick-line muted">{property.address}</span>
        <span className="quick-line strong">{factsLine}</span>
        {scanCount > 0 && (
          <div className="quick-actions">
            <span className="tag">
              <span className="tag-dot" />
              {scanCount === 1 ? '3D scan' : `${scanCount} 3D scans`}
            </span>
            <button className="button" onClick={onFlyThrough}>
              Enter fly-through
            </button>
          </div>
        )}
        <div className="tool-row" role="toolbar" aria-label="Tools">
          {toolsFor(property).map((t) => (
            <button key={t.id} className="circle tool-button" aria-label={t.label} title={t.label} onClick={() => onTool(t.id)}>
              <t.icon size={16} />
            </button>
          ))}
        </div>
      </div>
    </section>
  )
}

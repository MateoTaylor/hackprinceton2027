import { Building2, Grid2x2 } from 'lucide-react'
import { useState } from 'react'
import type { Direction } from '../../shared/api'
import { DIRECTIONS } from './api'

export type Oblique =
  | { status: 'flying' }
  | { status: 'loading' }
  | { status: 'none' }
  | { status: 'error' }
  | { status: 'ready'; directions: Direction[]; dir: Direction | null }

type ControlsProps = { oblique: Oblique | null; onDir: (dir: Direction | null) => void }

// The view toggle, the compass-point toggle and the quiet notes about oblique imagery.
export function ObliqueControls({ oblique, onDir }: ControlsProps) {
  const ready = oblique?.status === 'ready' ? oblique : null
  const showing = ready?.dir ?? null

  return (
    <>
      <div className="map-control surface-pill view-toggle" role="group" aria-label="Imagery">
        <button aria-label="Ortho" aria-pressed={showing === null} onClick={() => onDir(null)}>
          <Grid2x2 size={16} />
        </button>
        <button aria-label="Oblique" aria-pressed={showing !== null} disabled={!ready} onClick={() => ready && onDir(showing ?? ready.directions[0])}>
          <Building2 size={16} />
        </button>
      </div>
      {ready && (
        <div className="map-control surface-pill direction-toggle" role="group" aria-label="Camera facing">
          {DIRECTIONS.map((d) => (
            <button key={d} aria-label={`Facing ${d}`} aria-pressed={d === showing} disabled={!ready.directions.includes(d)} onClick={() => onDir(d)}>
              {d[0].toUpperCase()}
            </button>
          ))}
        </div>
      )}
      {oblique?.status === 'loading' && <div className="map-control surface-pill map-note">Looking for oblique views…</div>}
      {oblique?.status === 'none' && <div className="map-control surface-pill map-note">No oblique views for this property</div>}
      {oblique?.status === 'error' && <div className="map-control surface-pill map-note">Could not load oblique views</div>}
    </>
  )
}

// Fades the oblique photo in over the map once it loads, and fades the last one out when `src` goes null.
export function ObliquePhoto({ src }: { src: string | null }) {
  const [current, setCurrent] = useState(src)
  const [loaded, setLoaded] = useState<string | null>(null)
  if (src && src !== current) setCurrent(src)

  return current ? (
    <img
      className={`oblique-photo${src && loaded === current ? ' loaded' : ''}`}
      src={current}
      alt=""
      onLoad={() => setLoaded(current)}
      onError={() => setLoaded(null)}
    />
  ) : null
}

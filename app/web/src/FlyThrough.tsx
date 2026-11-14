import { X } from 'lucide-react'
import type { Property } from '../../shared/property'

type Props = { property: Property; modelId: string; onModel: (modelId: string) => void; onClose: () => void }

// Matterport's hosted Showcase in an iframe. `play=1` starts the tour without a click-to-load screen.
export function FlyThrough({ property, modelId, onModel, onClose }: Props) {
  const scan = property.scans.find((s) => s.modelId === modelId)
  return (
    <section className="flythrough" aria-label={`Fly-through of ${property.name}`}>
      <div className="flythrough-bar">
        <div className="flythrough-title">
          <strong>{property.name}</strong>
          <span>{scan?.name ?? property.address}</span>
        </div>
        {property.scans.length > 1 && (
          <div className="chip-row" role="group" aria-label="Scans">
            {property.scans.map((s, i) => (
              <button key={s.modelId} className="chip" aria-pressed={s.modelId === modelId} title={s.name} onClick={() => onModel(s.modelId)}>
                Scan {i + 1}
              </button>
            ))}
          </div>
        )}
        <button className="circle accent" aria-label="Close fly-through" onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      <iframe
        key={modelId}
        title={scan?.name ?? 'Matterport scan'}
        src={`https://my.matterport.com/show/?m=${encodeURIComponent(modelId)}&play=1`}
        allow="fullscreen; xr-spatial-tracking"
      />
    </section>
  )
}

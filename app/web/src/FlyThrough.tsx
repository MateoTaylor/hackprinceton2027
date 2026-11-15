import { LoaderCircle, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { RenderSlides } from '../../shared/api'
import type { Property } from '../../shared/property'
import { AnchoredEdits } from './AnchoredEdits'
import { getJson } from './api'
import { useScene, type ViewerState } from './scene/useScene'

type Props = { property: Property; modelId: string; onModel: (modelId: string) => void; onClose: () => void }

// The Showcase viewer for one of the property's scans. When the visitor stands on a sweep that
// one of Mateo's prepared edits was seen from, each edited object there gets a frame with < and >
// that flips it between before and after.
export function FlyThrough({ property, modelId, onModel, onClose }: Props) {
  const scan = property.scans.find((s) => s.modelId === modelId)
  const { container, viewer } = useScene(modelId)
  const sweep = useCurrentSweep(viewer)
  const renders = useRenders(modelId)
  const slides = (sweep && renders[sweep]) || []

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
      <div className="flythrough-stage">
        <div className="flythrough-viewer" ref={container} />
        {viewer.status === 'loading' && (
          <p className="flythrough-status" role="status">
            <LoaderCircle className="panel-spinner" size={16} aria-hidden />
            Loading the scan
          </p>
        )}
        {viewer.status === 'error' && (
          <p className="flythrough-status" role="alert">
            {viewer.message}
          </p>
        )}
        {viewer.status === 'ready' && slides.length > 0 && <AnchoredEdits key={sweep} handle={viewer.handle} slides={slides} />}
      </div>
    </section>
  )
}

// The sid of the sweep the visitor stands on, or null while moving or before the viewer is ready.
function useCurrentSweep(viewer: ViewerState) {
  const [sweep, setSweep] = useState<string | null>(null)
  const sdk = viewer.status === 'ready' ? viewer.handle.sdk : null
  useEffect(() => {
    setSweep(null)
    if (!sdk) return
    const subscription = sdk.Sweep.current.subscribe((current) => setSweep(current.sid || null))
    return () => subscription.cancel()
  }, [sdk])
  return sweep
}

function useRenders(modelId: string) {
  const [sweeps, setSweeps] = useState<RenderSlides['sweeps']>({})
  useEffect(() => {
    const controller = new AbortController()
    setSweeps({})
    getJson(`/api/renders/${encodeURIComponent(modelId)}`, controller.signal).then(
      (answer) => setSweeps((answer as RenderSlides).sweeps),
      () => {},
    )
    return () => controller.abort()
  }, [modelId])
  return sweeps
}

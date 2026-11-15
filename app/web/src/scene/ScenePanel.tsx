import { LoaderCircle } from 'lucide-react'
import { useState } from 'react'
import type { PanelProps } from '../tools'
import { triangleCount } from './host'
import { isSpaceId, SPACES, type SpaceEntry } from './spaces'
import { useScene } from './useScene'
import './scene.css'

const numbers = new Intl.NumberFormat('en-US')

export default function ScenePanel({ property }: PanelProps) {
  const spaces: SpaceEntry[] = [
    ...SPACES,
    ...property.scans
      .filter((scan) => isSpaceId(scan.modelId) && !SPACES.some((space) => space.id === scan.modelId))
      .map((scan) => ({ id: scan.modelId, label: scan.name, kind: 'property' as const })),
  ]
  const [spaceId, setSpaceId] = useState(SPACES[0].id)
  const { container, viewer } = useScene(spaceId)
  const meshes = viewer.status === 'ready' ? viewer.handle.meshes() : []

  return (
    <div className="scene-panel">
      <div className="chip-row" role="group" aria-label="Space">
        {spaces.map((space) => (
          <button key={space.id} className="chip" aria-pressed={space.id === spaceId} onClick={() => setSpaceId(space.id)}>
            {space.label}
          </button>
        ))}
      </div>
      <p className="scene-status" role="status">
        {viewer.status === 'loading' && (
          <>
            <LoaderCircle className="panel-spinner" size={16} aria-hidden />
            Loading the scan
          </>
        )}
        {viewer.status === 'ready' && `${numbers.format(meshes.length)} meshes · ${numbers.format(Math.round(triangleCount(meshes)))} triangles`}
        {viewer.status === 'error' && <span className="scene-error">{viewer.message}</span>}
      </p>
      <div className="scene-viewer" ref={container} />
    </div>
  )
}

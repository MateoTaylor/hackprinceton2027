import { useEffect, useMemo, useRef, useState } from 'react'
import type { BuildingModel } from '../../../server/src/model/building.ts'
import { buildCutaway, viewBox } from './cutaway.ts'
import './dollhouse.css'
import { loadKit } from './kit.ts'
import { DEFAULT_LOOK, type Look } from './looks.ts'
import { createStage, type Pick, type StageLayer } from './stage.ts'
import { focusBox } from './view.ts'

export type DollhouseProps = {
  building: BuildingModel
  look?: Look
  storeyIndex: number | null
  layers?: StageLayer[]
  revision?: unknown
  onPick?: (pick: Pick) => void
  onHover?: (pick: Pick | null) => void
}

type Stage = ReturnType<typeof createStage>

// Draws a building opened at `storeyIndex` (null for the whole building) on a canvas that fills
// its parent. Pass `layers` to draw into the same view; a layer with `onStorey` shows only while
// that storey is open. The view frames the building, or the open storey's scanned space, when
// it opens and again when `building` or `storeyIndex` changes; a change of `layers` never moves
// the camera, so a caller can animate them freely. A caller that changes a layer's objects in
// place passes a new `revision` to have them redrawn.
//   <Dollhouse building={detail.building} storeyIndex={5} layers={[trail]} onPick={setPick} />
export function Dollhouse({ building, look = DEFAULT_LOOK, storeyIndex, layers, revision, onPick, onHover }: DollhouseProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [stage, setStage] = useState<Stage | null>(null)
  const kit = useMemo(loadKit, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const created = createStage(canvas, look)
    const observer = new ResizeObserver(() => created.resize(canvas.clientWidth, canvas.clientHeight))
    observer.observe(canvas)
    setStage(created)
    return () => {
      observer.disconnect()
      created.dispose()
      setStage(null)
    }
  }, [look])

  const cutaway = useMemo(() => buildCutaway(building, storeyIndex, look, kit), [building, storeyIndex, look, kit])

  useEffect(() => {
    if (!stage) return
    stage.setLayers([...cutaway, ...(layers ?? [])])
    stage.setStorey(storeyIndex)
  }, [stage, cutaway, layers, revision, storeyIndex])

  useEffect(() => {
    stage?.frame(focusBox(building, storeyIndex), viewBox(building))
  }, [stage, building, storeyIndex])

  useEffect(() => {
    stage?.setHandlers({ onPick, onHover })
  }, [stage, onPick, onHover])

  return <canvas ref={canvasRef} className="dollhouse" />
}

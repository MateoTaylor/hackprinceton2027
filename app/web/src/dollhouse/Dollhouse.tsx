import { useEffect, useMemo, useRef, useState } from 'react'
import type { BuildingModel } from '../../../server/src/model/building.ts'
import { buildCutaway, viewBox } from './cutaway.ts'
import './dollhouse.css'
import { loadKit } from './kit.ts'
import { DEFAULT_LOOK, type Look } from './looks.ts'
import { createStage, type Pick, type StageLayer } from './stage.ts'

export type DollhouseProps = {
  building: BuildingModel
  look?: Look
  storeyIndex: number | null
  layers?: StageLayer[]
  onPick?: (pick: Pick) => void
  onHover?: (pick: Pick | null) => void
}

type Stage = ReturnType<typeof createStage>

// Draws a building opened at `storeyIndex` (null for the whole building) on a canvas that fills
// its parent. Pass `layers` to draw into the same view; a layer with `onStorey` shows only while
// that storey is open. The view frames the building again when `building` changes.
//   <Dollhouse building={detail.building} storeyIndex={5} layers={[trail]} onPick={setPick} />
export function Dollhouse({ building, look = DEFAULT_LOOK, storeyIndex, layers, onPick, onHover }: DollhouseProps) {
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
  }, [stage, cutaway, layers, storeyIndex])

  useEffect(() => {
    stage?.frame(viewBox(building))
  }, [stage, building])

  useEffect(() => {
    stage?.setHandlers({ onPick, onHover })
  }, [stage, onPick, onHover])

  return <canvas ref={canvasRef} className="dollhouse" />
}

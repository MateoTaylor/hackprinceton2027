import '@fontsource-variable/inter'
import '../styles.css'
import { StrictMode, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Box3, Group, InstancedMesh, Matrix4, Mesh, MeshStandardMaterial, PlaneGeometry, Color } from 'three'
import type { BuildingModel } from '../../../server/src/model/building.ts'
import { FIXTURES } from '../../../server/src/model/fixtures.ts'
import { Dollhouse } from './Dollhouse.tsx'
import { KIT, loadKit } from './kit.ts'
import { Legend } from './Legend.tsx'
import { DEFAULT_LOOK } from './looks.ts'
import { protoMaterial } from './protoGrid.ts'
import { createStage } from './stage.ts'

const CELLS = [
  { name: 'Office tower', building: FIXTURES.officeTower },
  { name: 'Warehouse', building: FIXTURES.warehouse },
  { name: 'Apartment', building: FIXTURES.apartment },
]

const KIT_COLUMNS = 5
const KIT_SPACING_M = 4

const hasScan = ({ spaces }: BuildingModel['storeys'][number]) => spaces.some(({ source }) => source === 'scan')

function LookCell({ name, building }: { name: string; building: BuildingModel }) {
  const [storeyIndex, setStoreyIndex] = useState<number | null>(() => building.storeys.find(hasScan)?.index ?? null)
  return (
    <figure className="look-cell">
      <div className="look-view">
        <Dollhouse building={building} storeyIndex={storeyIndex} />
      </div>
      <select className="look-storey" value={storeyIndex ?? ''} onChange={(event) => setStoreyIndex(event.target.value === '' ? null : Number(event.target.value))}>
        <option value="">Whole building</option>
        {building.storeys.toSorted((a, b) => b.index - a.index).map((storey) => (
          <option key={storey.index} value={storey.index}>
            {storey.label}
            {hasScan(storey) ? ' (scanned)' : ''}
          </option>
        ))}
      </select>
      <figcaption>
        <span className="look-name">{name}</span>
        <span className="look-meta">
          {building.storeys.length} storeys, {building.shell.heightM.toFixed(1)} m
        </span>
      </figcaption>
    </figure>
  )
}

// One of each furnishing kind in its kit colour, in rows of five, read left to right from the back.
function KitSheet() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const stage = createStage(canvas, DEFAULT_LOOK)
    const kit = loadKit()
    const group = new Group()
    const material = new MeshStandardMaterial({ color: '#FFFFFF', roughness: DEFAULT_LOOK.roughness })
    KIT.forEach(({ kind }, i) => {
      const model = kit.get(kind)
      if (!model) return
      const mesh = new InstancedMesh(model.geometry, material, 1)
      mesh.setMatrixAt(0, new Matrix4().makeTranslation((i % KIT_COLUMNS) * KIT_SPACING_M, 0, Math.floor(i / KIT_COLUMNS) * KIT_SPACING_M))
      mesh.setColorAt(0, new Color(DEFAULT_LOOK.palette.furniture[model.tone]))
      mesh.castShadow = mesh.receiveShadow = true
      group.add(mesh)
    })
    const rows = Math.ceil(KIT.length / KIT_COLUMNS)
    const ground = new Mesh(new PlaneGeometry(KIT_COLUMNS * KIT_SPACING_M, rows * KIT_SPACING_M).rotateX(-Math.PI / 2), protoMaterial('context', DEFAULT_LOOK))
    ground.position.set(((KIT_COLUMNS - 1) * KIT_SPACING_M) / 2, 0, ((rows - 1) * KIT_SPACING_M) / 2)
    ground.receiveShadow = true
    group.add(ground)
    stage.setLayers([{ id: 'kit', object: group }])
    stage.frame(new Box3().setFromObject(group))
    const observer = new ResizeObserver(() => stage.resize(canvas.clientWidth, canvas.clientHeight))
    observer.observe(canvas)
    return () => {
      observer.disconnect()
      stage.dispose()
    }
  }, [])

  return (
    <figure className="look-cell">
      <canvas ref={canvasRef} />
      <figcaption>
        <ol className="look-kit-names">
          {KIT.map(({ kind }) => (
            <li key={kind}>{kind.replace('_', ' ')}</li>
          ))}
        </ol>
      </figcaption>
    </figure>
  )
}

// `?only=N` shows the Nth fixture alone, large enough to read doors and furniture.
const only = new URLSearchParams(location.search).get('only')

function LookPage() {
  const cells = only === null ? CELLS : CELLS.slice(Number(only), Number(only) + 1)
  return (
    <main className="look-page">
      <header className="look-head">
        <h1>{DEFAULT_LOOK.label} look</h1>
        <Legend inferredShare={0.62} />
      </header>
      <div className={only === null ? 'look-grid' : 'look-grid single'}>
        {cells.map(({ name, building }) => (
          <LookCell key={building.propertyId} name={name} building={building} />
        ))}
        {only === null && <KitSheet />}
      </div>
    </main>
  )
}

const root = document.getElementById('root')
if (!root) throw new Error('look.html has no #root')

createRoot(root).render(
  <StrictMode>
    <LookPage />
  </StrictMode>,
)

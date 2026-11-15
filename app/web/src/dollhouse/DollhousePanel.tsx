import { useState } from 'react'
import type { BuildingDetail, BuildingModel } from '../../../server/src/model/building.ts'
import { OpStatus, useOp } from '../ToolPanel'
import type { PanelProps } from '../tools'
import { Dollhouse } from './Dollhouse.tsx'
import './dollhouse.css'
import { Legend } from './Legend.tsx'

type BuildingResult = { inferredShare: number; assumptions: string[]; counts: { unplacedScans: number } }

const hasScan = ({ spaces }: BuildingModel['storeys'][number]) => spaces.some(({ source }) => source === 'scan')

// The storey to open first: the lowest that holds scanned space, else the ground storey.
const firstStorey = ({ storeys }: BuildingModel) => (storeys.find(hasScan) ?? storeys[0])?.index ?? null

// The Dollhouse panel. ToolPanel draws its frame and passes the selected property.
export default function DollhousePanel({ property }: PanelProps) {
  const op = useOp<BuildingResult, BuildingDetail>('building_get', { propertyId: property.id }, { detail: true })
  if (op.status !== 'ready') return <OpStatus state={op} />
  return <DollhouseView key={property.id} building={op.detail.building} result={op.result} />
}

function DollhouseView({ building, result }: { building: BuildingModel; result: BuildingResult }) {
  const [storeyIndex, setStoreyIndex] = useState<number | null>(() => firstStorey(building))
  const storeys = building.storeys.toSorted((a, b) => b.index - a.index)
  const unplaced = result.counts.unplacedScans

  return (
    <div className="dollhouse-panel">
      <div className="dollhouse-view">
        <Dollhouse building={building} storeyIndex={storeyIndex} />
      </div>
      <nav className="storey-picker" aria-label="Storeys">
        <button className="chip" aria-pressed={storeyIndex === null} onClick={() => setStoreyIndex(null)}>
          Whole building
        </button>
        {storeys.map((storey) => (
          <button key={storey.index} className="chip" aria-pressed={storeyIndex === storey.index} onClick={() => setStoreyIndex(storey.index)}>
            {storey.label}
            {hasScan(storey) && <span className="storey-scanned" aria-label="scanned" />}
          </button>
        ))}
      </nav>
      <div className="dollhouse-notes">
        <Legend inferredShare={result.inferredShare} />
        {unplaced > 0 && <span>{unplaced === 1 ? '1 scan could not be placed.' : `${unplaced} scans could not be placed.`}</span>}
        {result.assumptions.length > 0 && (
          <ul>
            {result.assumptions.map((assumption) => (
              <li key={assumption}>{assumption}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Property } from '../../../../shared/property.ts'
import { BuildingDetail, checkBuilding, type Opening, type Ring, type Space, type Storey } from '../../model/building.ts'
import { ringArea } from '../../model/geo.ts'
import type { Matterport } from '../../matterport.ts'
import { UpstreamError, type Vexcel } from '../../vexcel.ts'
import { OpError, type OpContext } from '../op.ts'
import { FURNISHING_ASSUMPTION, furnishStorey } from './furnish.ts'
import { gapFill, layoutOf } from './gapFill.ts'
import { placeScan } from './placement.ts'
import { fetchScanPlan, type ScanPlan } from './scanPlan.ts'
import { buildShell, pickCapture } from './shell.ts'
import { stackStoreys } from './storeys.ts'

// Raise it whenever a step changes its output, so old cache files are no longer read.
export const BUILDING_VERSION = 2

const NEIGHBOUR_BUFFER_M = 150
// `calculated` alone carries heights without the footprint, the capture date or the primary flag.
const INCLUDE = ['precomputed', 'calculated'] as const
const ASSUMPTIONS_MAX = 8
// Scan failures that a later call may not hit, so a building that has one is not cached.
const PASSING = new Set(['upstream', 'not_ready'])

export const buildingCacheFile = (dataDir: string, propertyId: string) => join(dataDir, 'cache', 'building', `${propertyId}-${BUILDING_VERSION}.json`)

async function readCached(file: string) {
  try {
    const parsed = BuildingDetail.safeParse(JSON.parse(await readFile(file, 'utf8')))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

async function writeCached(file: string, detail: BuildingDetail) {
  await mkdir(join(file, '..'), { recursive: true })
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, JSON.stringify(detail))
    await rename(temp, file)
  } finally {
    await rm(temp, { force: true })
  }
}

// What building a property reads: the two upstream clients, CoStar's facts and the cache folder.
export type BuildContext = Pick<OpContext, 'buildingFacts' | 'dataDir'> & { vexcel: Pick<Vexcel, 'extract'>; matterport: Pick<Matterport, 'floorPlan'> | null }

type ScanResult = { kind: 'plan'; scan: Property['scans'][number]; plan: ScanPlan } | { kind: 'failed'; modelId: string; name: string; reason: string; passing: boolean }

async function loadScan(ctx: Pick<BuildContext, 'matterport'>, scan: Property['scans'][number]): Promise<ScanResult> {
  try {
    return { kind: 'plan', scan, plan: await fetchScanPlan(ctx, scan.modelId) }
  } catch (error) {
    if (!(error instanceof OpError)) throw error
    return { kind: 'failed', modelId: scan.modelId, name: scan.name.slice(0, 120) || scan.modelId, reason: `${error.code}: ${error.message}`.slice(0, 200), passing: PASSING.has(error.code) }
  }
}

// The share of floor area across storeys whose space is inferred rather than scanned.
export function inferredShareOf(storeys: Storey[]) {
  const area = (spaces: Space[]) => spaces.reduce((sum, { ring }) => sum + ringArea(ring), 0)
  const total = area(storeys.flatMap(({ spaces }) => spaces))
  if (total === 0) return 0
  return Math.min(1, area(storeys.flatMap(({ spaces }) => spaces.filter(({ source }) => source === 'inferred'))) / total)
}

// Merges repeated assumptions and keeps at most eight, in their order. Every `required` sentence is
// kept, such as the ones saying that rooms and furniture were inferred, and the rest fill what
// room is left.
//   capAssumptions([...shellSentences, ...scanSentences], gapFillSentences)
export function capAssumptions(sentences: string[], required: string[]) {
  const must = new Set(required)
  const unique = [...new Set([...sentences, ...required])]
  const optional = new Set(unique.filter((sentence) => !must.has(sentence)).slice(0, Math.max(0, ASSUMPTIONS_MAX - must.size)))
  return unique.filter((sentence) => must.has(sentence) || optional.has(sentence)).slice(0, ASSUMPTIONS_MAX)
}

// Builds a property's building, from the shell through the storeys, the scans, the gap fill and
// the furnishings, or reads it from the cache. A building with a scan that failed upstream is
// returned but not cached. Throws `upstream` when Vexcel fails and `internal` when the model it
// builds is not valid.
//   const detail = await buildBuilding(ctx, requireProperty(ctx, 'commercial-248243'))
export async function buildBuilding(ctx: BuildContext, property: Property): Promise<BuildingDetail> {
  const file = buildingCacheFile(ctx.dataDir, property.id)
  const cached = await readCached(file)
  if (cached) return cached

  const { lat, lon } = property
  const [own, neighbours] = await Promise.all([
    ctx.vexcel.extract(lat, lon, { include: INCLUDE }),
    ctx.vexcel.extract(lat, lon, { bufferM: NEIGHBOUR_BUFFER_M, include: INCLUDE }),
  ]).catch((error) => {
    if (error instanceof UpstreamError) throw new OpError('upstream', 'Vexcel did not answer.', 'Try again in a minute.')
    throw error
  })
  const shell = buildShell(property, pickCapture(own), neighbours)
  const stacked = stackStoreys(shell.shell, ctx.buildingFacts.get(property.id), property)
  const assumptions = [...shell.assumptions, ...stacked.assumptions]

  const loaded = await Promise.all(property.scans.map((scan) => loadScan(ctx, scan)))
  const failed = loaded.flatMap((entry) => (entry.kind === 'failed' ? [entry] : []))
  const unplacedScans = failed.map(({ modelId, name, reason }) => ({ modelId, name, reason }))
  const taken = new Map<number, Ring[]>()
  const spacesOn = new Map<number, Space[]>()
  const openingsOn = new Map<number, Opening[]>()
  const scans = []
  const scanConnectors = []
  for (const entry of loaded) {
    if (entry.kind !== 'plan') continue
    const placement = placeScan(entry.plan, entry.scan, stacked.storeys, taken, property.address)
    if (placement.kind === 'unplaced') {
      unplacedScans.push({ modelId: placement.modelId, name: placement.name, reason: placement.reason })
      continue
    }
    for (const [index, spaces] of placement.spaces) {
      spacesOn.set(index, [...(spacesOn.get(index) ?? []), ...spaces])
      taken.set(index, [...(taken.get(index) ?? []), ...spaces.map(({ ring }) => ring)])
    }
    for (const [index, openings] of placement.openings) openingsOn.set(index, [...(openingsOn.get(index) ?? []), ...openings])
    scans.push(placement.scan)
    scanConnectors.push(...placement.connectors)
    assumptions.push(...placement.assumptions)
  }

  const withScans = stacked.storeys.map((storey) => ({ ...storey, spaces: spacesOn.get(storey.index) ?? [], openings: openingsOn.get(storey.index) ?? [] }))
  const filled = gapFill(withScans, scanConnectors, property.id, layoutOf(property.typeLabel))
  const storeys = filled.storeys.map(furnishStorey)
  const inferred = [...filled.assumptions, ...(storeys.some(({ furnishings }) => furnishings.length) ? [FURNISHING_ASSUMPTION] : [])]

  const detail: BuildingDetail = {
    building: {
      propertyId: property.id,
      origin: shell.origin,
      shell: shell.shell,
      context: shell.context,
      storeys,
      connectors: filled.connectors,
      scans,
      assumptions: capAssumptions(assumptions, inferred),
    },
    unplacedScans,
  }
  const problems = checkBuilding(detail.building)
  if (problems.length) {
    throw new OpError('internal', `The building model has ${problems.length} problems.`, 'This is a bug in the building generator. Try another property.')
  }
  if (!failed.some(({ passing }) => passing)) await writeCached(file, detail)
  return detail
}

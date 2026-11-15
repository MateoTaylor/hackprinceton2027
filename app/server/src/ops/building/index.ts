import { z } from 'zod'
import { BuildingDetail } from '../../model/building.ts'
import { Assumptions, defineOp, requireProperty } from '../op.ts'
import { buildBuilding, inferredShareOf } from './build.ts'

const Count = z.int().min(0)

const BuildingResult = z.object({
  propertyId: z.string(),
  heightM: z.number().positive(),
  counts: z.object({
    volumes: Count,
    neighbours: Count,
    storeys: Count,
    spaces: Count,
    openings: Count,
    furnishings: Count,
    connectors: Count,
    scans: Count,
    unplacedScans: Count,
  }),
  inferredShare: z.number().min(0).max(1).describe('The share of floor area whose source is inferred.'),
  assumptions: Assumptions,
})

const buildingGet = defineOp({
  name: 'building_get',
  summary: 'The building model of a property: its shell, storeys, spaces, doors and furnishings.',
  effect: 'read',
  input: z.object({ propertyId: z.string().describe('A property id from GET /api/properties, such as "commercial-248243".') }),
  output: BuildingResult,
  detail: BuildingDetail,
})(async (ctx, { propertyId }) => {
  const detail = await buildBuilding(ctx, requireProperty(ctx, propertyId))
  const { building, unplacedScans } = detail
  const { storeys } = building
  const count = (pick: (storey: (typeof storeys)[number]) => unknown[]) => storeys.reduce((sum, storey) => sum + pick(storey).length, 0)
  return {
    result: {
      propertyId,
      heightM: building.shell.heightM,
      counts: {
        volumes: building.shell.volumes.length,
        neighbours: building.context.length,
        storeys: storeys.length,
        spaces: count(({ spaces }) => spaces),
        openings: count(({ openings }) => openings),
        furnishings: count(({ furnishings }) => furnishings),
        connectors: building.connectors.length,
        scans: building.scans.length,
        unplacedScans: unplacedScans.length,
      },
      inferredShare: inferredShareOf(storeys),
      assumptions: building.assumptions,
    },
    detail,
  }
})

export const BUILDING_OPS = [buildingGet]

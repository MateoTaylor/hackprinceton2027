import { z } from 'zod'
import { BuildingDetail, BuildingModel, Point } from '../../model/building.ts'
import { Assumptions, Confidence, defineOp, OpError, Source } from '../op.ts'
import { DEFAULT_DOOR_HEIGHT_M, FIT_CAP } from './doorFit.ts'
import { PAYLOAD_NAMES, resolvePayload } from './payload.ts'
import { solveRoute } from './solve.ts'

const RESULT_DOORS = 20

const RouteDoor = z.object({
  openingId: z.string(),
  storeyIndex: z.int().min(0),
  verdict: z.enum(['pass', 'fail']),
  clearanceM: z.number(),
  confidence: Confidence,
  limitedBy: z.enum(['width', 'height']),
  source: Source,
})

const RouteResult = z.object({
  reachable: z.boolean(),
  target: z.object({ spaceId: z.string().nullable(), storeyIndex: z.int().min(0) }),
  lengthM: z.number().nullable(),
  doorCount: z.int().min(0),
  failCount: z.int().min(0),
  doors: z.array(RouteDoor).max(RESULT_DOORS).describe(`The first ${RESULT_DOORS} doors on the route, from the entrance.`),
  confidence: Confidence.nullable(),
  connector: z.object({ id: z.string(), kind: z.enum(['stair', 'elevator']) }).nullable(),
  assumptions: Assumptions,
})
export type RouteResult = z.infer<typeof RouteResult>

// The geometry the Routing panel draws. `trail` is `[x, y, storeyIndex]` in the building frame.
const RouteDetail = z.object({
  trail: z.array(z.tuple([z.number(), z.number(), z.int().min(0)])),
  doors: z.array(RouteDoor.extend({ at: Point })),
  target: z.object({ storeyIndex: z.int().min(0), at: Point }),
})
export type RouteDetail = z.infer<typeof RouteDetail>

// building_get may answer with no storeys while a property has none yet, which BuildingModel does
// not allow. Accept that here so it becomes `no_data`, not a bug.
const BuildingAnswer = BuildingDetail.extend({ building: BuildingModel.extend({ storeys: z.array(BuildingModel.shape.storeys.element) }) })

const routeSolve = defineOp({
  name: 'route_solve',
  summary: 'The best route from the street to a space or point for a payload, with a verdict on every door it passes.',
  effect: 'read',
  input: z.object({
    propertyId: z.string().describe('A property id from GET /api/properties.'),
    target: z
      .union([z.object({ spaceId: z.string() }), z.object({ at: z.tuple([z.number(), z.number()]) })])
      .describe('A space id from building_get, or a point [x, y] in metres on a storey.'),
    storeyIndex: z.int().min(0).optional().describe('The storey of an { at } target.'),
    payload: z.enum(PAYLOAD_NAMES),
    widthM: z.number().positive().optional().describe('The width of a custom payload in metres.'),
    heightM: z.number().positive().optional().describe('The height of a custom payload in metres.'),
  }),
  output: RouteResult,
  detail: RouteDetail,
})(async (ctx, input) => {
  const { payload, assumption } = resolvePayload(input)
  const answer = BuildingAnswer.safeParse((await ctx.call('building_get', { propertyId: input.propertyId })).detail)
  if (!answer.success) throw new Error('building_get answered a building route_solve cannot read.')
  const { building } = answer.data
  if (!building.storeys.some(({ spaces }) => spaces.length)) {
    throw new OpError('no_data', 'This building has no rooms to route through yet.', 'Check building_get for this property; its storeys have no spaces.')
  }
  const target = 'spaceId' in input.target ? input.target : { at: input.target.at, storeyIndex: input.storeyIndex }
  const { target: end, route } = solveRoute(building, target, payload)

  const assumptions = [
    assumption,
    'Furniture is ignored, since every piece of it is a guess.',
    `Door confidence is capped at ${FIT_CAP}, since the door leaf and its swing are unknown.`,
    ...(payload.wheeled ? ['Stairs are closed to a wheeled payload.'] : []),
    ...(route?.usesElevator ? ['An elevator is taken to fit any payload.'] : []),
    ...(route?.usesDefaultDoorHeight ? [`A door with no known height is taken as ${DEFAULT_DOOR_HEIGHT_M} m tall.`] : []),
  ]
  const toResultDoor = ({ at: _, ...door }: RouteDetail['doors'][number]) => door
  return {
    result: {
      reachable: route !== null,
      target: { spaceId: end.spaceId, storeyIndex: end.storeyIndex },
      lengthM: route?.lengthM ?? null,
      doorCount: route?.doors.length ?? 0,
      failCount: route?.failCount ?? 0,
      doors: (route?.doors ?? []).slice(0, RESULT_DOORS).map(toResultDoor),
      confidence: route?.confidence ?? null,
      connector: route?.connector ?? null,
      assumptions,
    },
    detail: { trail: route?.trail ?? [], doors: route?.doors ?? [], target: { storeyIndex: end.storeyIndex, at: end.at } },
  }
})

export const ROUTE_OPS = [routeSolve]

import { z } from 'zod'
import { Assumptions, Confidence, Source } from '../ops/op.ts'
import { FURNISHING_KINDS } from './furnishings.ts'
import { pointInRing, ringArea } from './geo.ts'

const Id = z.string().min(1).max(64)
const Label = z.string().min(1).max(60)
const Metres = z.number()
const Length = z.number().positive()
const Degrees = z.number().min(0).lt(360)
const Fraction = z.number().min(0).max(1)

// A point of the building frame: metres east and north of `origin`.
export const Point = z.tuple([Metres, Metres])
export type Point = z.infer<typeof Point>

// A counter-clockwise outline with the first point not repeated. `orientCcw` makes one.
export const Ring = z.array(Point).min(3)
export type Ring = z.infer<typeof Ring>

const provenance = { source: Source, confidence: Confidence }

// One extruded part of the outside, from `baseM` to `topM` above the ground. The `primary` volume
// is the main building; the rest are podiums, wings and penthouses.
const Volume = z.object({ id: Id, ring: Ring, baseM: Metres, topM: Length, primary: z.boolean(), ...provenance })

const Space = z.object({ id: Id, label: Label, ring: Ring, ...provenance })

// A gap in a wall at `at`. `heightM` is null for a full-height opening. `bearingDeg` is the way
// you face walking through it from `spaceIds[0]` to `spaceIds[1]`, which for an exterior door is
// from the space to the outside.
const openingFields = { id: Id, at: Point, widthM: Length, heightM: Length.nullable(), bearingDeg: Degrees, ...provenance }
const Opening = z.discriminatedUnion('kind', [
  z.object({ kind: z.enum(['door', 'opening']), spaceIds: z.tuple([Id, Id]), ...openingFields }),
  z.object({ kind: z.literal('exterior_door'), spaceIds: z.tuple([Id, z.null()]), ...openingFields }),
])

// A piece of furniture centred on `at`. Its size is `FURNISHING_FOOTPRINTS[kind]`, and `yawDeg`
// turns it counter-clockwise.
const Furnishing = z.object({ id: Id, kind: z.enum(FURNISHING_KINDS), spaceId: Id, at: Point, yawDeg: Degrees, ...provenance })

// A storey and everything on it. `elevationM` is its floor above the ground, and index 0 is the
// ground storey.
const Storey = z.object({
  index: z.int().min(0),
  label: Label,
  elevationM: Metres,
  heightM: Length,
  ring: Ring,
  ...provenance,
  spaces: z.array(Space),
  openings: z.array(Opening),
  furnishings: z.array(Furnishing),
})

// A stair or a lift. Each landing is where it meets a storey, through `openingId` when a door
// leads onto it.
const Connector = z.object({
  id: Id,
  kind: z.enum(['stair', 'elevator']),
  landings: z.array(z.object({ storeyIndex: z.int().min(0), at: Point, openingId: Id.nullable() })).min(2),
  ...provenance,
})

// A Matterport scan placed in the building frame: a scan point turns counter-clockwise by
// `yawDeg`, then moves by `tx` and `ty`. An `outline` fit was matched to the storey ring and
// carries its overlap as `iou`; an `inferred` fit is a guess and has none.
const scanFields = {
  modelId: Id,
  name: z.string().min(1).max(120),
  storeyIndexes: z.array(z.int().min(0)).min(1),
  transform: z.object({ tx: Metres, ty: Metres, yawDeg: Degrees }),
  flipAmbiguous: z.boolean(),
  confidence: Confidence,
}
const Scan = z.discriminatedUnion('fit', [
  z.object({ ...scanFields, fit: z.literal('outline'), iou: Fraction }),
  z.object({ ...scanFields, fit: z.literal('inferred'), iou: z.null() }),
])

// One building in a local east, north, up frame in metres. The frame's origin is `origin.lat` and
// `origin.lon` at `origin.groundElevationM`. `context` holds the neighbours, drawn in grey.
// `checkBuilding` says whether a value is one.
export const BuildingModel = z.object({
  propertyId: Id,
  origin: z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180), groundElevationM: Metres }),
  shell: z.object({ heightM: Length, volumes: z.array(Volume).min(1) }),
  context: z.array(z.object({ ring: Ring, heightM: Length })),
  storeys: z.array(Storey).min(1),
  connectors: z.array(Connector),
  scans: z.array(Scan),
  assumptions: Assumptions,
})
export type BuildingModel = z.infer<typeof BuildingModel>

// A building with the scans that could not be placed in it, each with the reason as a sentence.
export const BuildingDetail = z.object({
  building: BuildingModel,
  unplacedScans: z.array(z.object({ modelId: Id, name: z.string().min(1).max(120), reason: z.string().min(1).max(200) })),
})
export type BuildingDetail = z.infer<typeof BuildingDetail>

export type Origin = BuildingModel['origin']
export type Volume = z.infer<typeof Volume>
export type Space = z.infer<typeof Space>
export type Opening = z.infer<typeof Opening>
export type Furnishing = z.infer<typeof Furnishing>
export type Storey = z.infer<typeof Storey>
export type Connector = z.infer<typeof Connector>
export type Scan = z.infer<typeof Scan>

const CONTAIN_TOLERANCE_M = 0.05
const STACK_TOLERANCE_M = 0.01

type Rule = (building: BuildingModel) => string[]

const idsAreUnique: Rule = ({ shell, storeys, connectors, scans }) => {
  const ids = [
    ...shell.volumes.map(({ id }) => id),
    ...storeys.flatMap(({ spaces, openings, furnishings }) => [...spaces, ...openings, ...furnishings].map(({ id }) => id)),
    ...connectors.map(({ id }) => id),
    ...scans.map(({ modelId }) => modelId),
  ]
  const counts = new Map<string, number>()
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1)
  return [...counts].filter(([, count]) => count > 1).map(([id, count]) => `The id "${id}" is used ${count} times.`)
}

const referencesResolve: Rule = ({ storeys, connectors, scans }) => {
  const storeyAt = new Map(storeys.map((storey) => [storey.index, storey]))
  const onStorey = storeys.flatMap(({ index, spaces, openings, furnishings }) => {
    const spaceIds = new Set(spaces.map(({ id }) => id))
    const missing = (owner: string, spaceId: string) =>
      spaceIds.has(spaceId) ? [] : [`${owner} names space "${spaceId}", which storey ${index} does not have.`]
    return [
      ...openings.flatMap(({ id, spaceIds: ids }) => ids.flatMap((spaceId) => (spaceId === null ? [] : missing(`Opening "${id}"`, spaceId)))),
      ...furnishings.flatMap(({ id, spaceId }) => missing(`Furnishing "${id}"`, spaceId)),
    ]
  })
  const landings = connectors.flatMap(({ id, landings }) =>
    landings.flatMap(({ storeyIndex, openingId }) => {
      const storey = storeyAt.get(storeyIndex)
      if (!storey) return [`Connector "${id}" lands on storey ${storeyIndex}, which does not exist.`]
      if (openingId === null || storey.openings.some((opening) => opening.id === openingId)) return []
      return [`Connector "${id}" names opening "${openingId}", which storey ${storeyIndex} does not have.`]
    }),
  )
  const scanned = scans.flatMap(({ modelId, storeyIndexes }) =>
    storeyIndexes.filter((index) => !storeyAt.has(index)).map((index) => `Scan "${modelId}" covers storey ${index}, which does not exist.`),
  )
  return [...onStorey, ...landings, ...scanned]
}

const flatRing = (owner: string, ring: Ring) =>
  ringArea(ring) > 0 ? [] : [`${owner} has a ring with no positive area. Rings run counter-clockwise.`]

const ringsAreValid: Rule = ({ shell, context, storeys }) => [
  ...shell.volumes.flatMap(({ id, ring }) => flatRing(`Volume "${id}"`, ring)),
  ...context.flatMap(({ ring }, i) => flatRing(`Context ${i}`, ring)),
  ...storeys.flatMap(({ index, ring, spaces }) => [
    ...flatRing(`Storey ${index}`, ring),
    ...spaces.flatMap(({ id, ring: spaceRing }) => flatRing(`Space "${id}"`, spaceRing)),
  ]),
]

const spacesLieInsideStoreys: Rule = ({ storeys }) =>
  storeys.flatMap(({ index, ring, spaces }) =>
    spaces.flatMap(({ id, ring: spaceRing }) => {
      const outside = spaceRing.filter((point) => !pointInRing(point, ring, CONTAIN_TOLERANCE_M)).length
      return outside ? [`Space "${id}" reaches outside storey ${index} at ${outside} of its ${spaceRing.length} corners.`] : []
    }),
  )

const storeysStack: Rule = ({ storeys }) =>
  storeys.flatMap(({ index, elevationM }, i) => {
    if (index !== i) return [`Storey ${index} sits at position ${i}. Storeys run from index 0 upward in order.`]
    if (i === 0) return []
    const below = storeys[i - 1]
    const gap = elevationM - (below.elevationM + below.heightM)
    return Math.abs(gap) > STACK_TOLERANCE_M ? [`Storey ${index} starts ${gap.toFixed(2)} m from the top of storey ${i - 1}.`] : []
  })

const RULES = [idsAreUnique, referencesResolve, ringsAreValid, spacesLieInsideStoreys, storeysStack]

// Returns every problem with a building as a sentence, or an empty list for a valid one. A value
// that does not match `BuildingModel` returns its schema issues as `path: message`.
//   assert.deepEqual(checkBuilding(FIXTURES.warehouse), [])
export function checkBuilding(building: unknown) {
  const parsed = BuildingModel.safeParse(building)
  if (!parsed.success) return parsed.error.issues.map(({ path, message }) => `${path.join('.') || 'building'}: ${message}`)
  return RULES.flatMap((rule) => rule(parsed.data))
}

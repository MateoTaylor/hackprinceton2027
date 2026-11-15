import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { BuildingModel, Point } from '../../model/building.ts'
import { readObliqueCamera } from '../../obliquePose.ts'
import { UpstreamError } from '../../vexcel.ts'
import { Assumptions, Confidence, defineOp, OpError, requireProperty, Source, type OpContext } from '../op.ts'
import { cameraInFrame } from './camera.ts'
import { readSigns, Sign, SizeM, withSignLock, writeSigns, type SignDocument } from './document.ts'
import { chooseLift, TALLEST_LIFT } from './lift.ts'
import { misfit, shellWalls, wallFacing, type Wall } from './walls.ts'
import { EQUIPMENT_CLASSES } from '../../model/equipment.ts'

// A person standing on the ground reaches a sign whose top is this low.
const REACH_FROM_GROUND_M = 2
// The most signs one property holds, so signage_get stays inside RESULT_MAX_CHARS.
export const MAX_SIGNS = 12
// signage_get lists walls at least this long. Shorter ones are corners of the outline.
const LISTED_WALL_M = 3
const DEFAULT_SIZE = { widthM: 3, heightM: 1 }
// A new sign's bottom edge sits this far above its wall's base unless told otherwise.
const DEFAULT_BOTTOM_M = 3

const Lift = z.object({ equipmentId: z.string(), class: z.enum(EQUIPMENT_CLASSES), label: z.string(), workingHeightM: z.number() })

const ReachingLift = Lift.extend({ marginM: z.number().describe('The working height left over above the height asked for.') })

const LiftResult = ReachingLift.extend({
  alternatives: z.array(Lift).max(3),
  assumptions: Assumptions,
  source: z.literal('maker'),
})

const liftChoose = defineOp({
  name: 'lift_choose',
  summary: 'The smallest lift class that reaches a working height and outreach on the given ground.',
  effect: 'read',
  input: z.object({
    heightM: z.number().positive().describe('The working height to reach in metres.'),
    outreachM: z.number().min(0).default(0).describe('The sideways reach in metres.'),
    ground: z.enum(['paved', 'unpaved']).default('paved'),
    overObstacle: z.boolean().default(false).describe('Whether the lift must reach up and over something.'),
  }),
  output: LiftResult,
})(async (_ctx, need) => {
  const chosen = chooseLift(need)
  if (!chosen) {
    throw new OpError('no_data', 'No lift in the catalogue meets this need.', `The tallest is the ${TALLEST_LIFT.label}, with a working height of ${TALLEST_LIFT.workingHeightM} m.`)
  }
  const brief = ({ id, class: liftClass, label, workingHeightM }: typeof chosen.lift) => ({ equipmentId: id, class: liftClass, label, workingHeightM })
  return {
    result: {
      ...brief(chosen.lift),
      marginM: Math.round((chosen.lift.workingHeightM - need.heightM) * 100) / 100,
      alternatives: chosen.alternatives.map(brief),
      assumptions: [
        'Working height is the platform height plus 6 ft, the reach of a person standing on it.',
        'The ground is taken as paved unless ground says otherwise.',
        'The permit for a lift on a public sidewalk was not researched.',
      ],
      source: 'maker',
    },
  }
})

const propertyId = z.string().describe('A commercial property id from GET /api/properties.')
const signId = z.string().describe('A sign id from signage_get.')
const expectedVersion = z.int().min(0).optional().describe('The version from signage_get. A newer one answers conflict.')
const wallIndex = z.int().min(0).describe('A wall index from signage_get.')
const alongM = z.number().describe("The sign's centre in metres from the wall's start corner.")
const bottomM = z.number().min(0).describe("The sign's bottom edge in metres above the ground.")
const sizeM = SizeM.describe('The face of the sign in metres.')

// The shell of a property's building as walls. Signage is for commercial buildings only.
async function shellOf(ctx: OpContext, id: string) {
  const property = requireProperty(ctx, id)
  if (property.kind !== 'commercial') throw new OpError('invalid_input', 'Signage is for commercial properties only.', 'Pick a property whose id starts with "commercial-".')
  const { detail } = await ctx.call('building_get', { propertyId: id })
  const { building } = z.object({ building: BuildingModel.pick({ origin: true, shell: true }) }).parse(detail)
  const source = building.shell.volumes.find(({ primary }) => primary)?.source ?? 'inferred'
  return { property, origin: building.origin, heightM: building.shell.heightM, walls: shellWalls(building.shell.volumes), source }
}

function requireWall(walls: readonly Wall[], index: number) {
  const wall = walls[index]
  if (!wall) throw new OpError('not_found', `This building has no wall ${index}.`, `Wall indexes run from 0 to ${walls.length - 1}. List them with signage_get.`)
  return wall
}

function requireSign(document: SignDocument, id: string) {
  const sign = document.signs.find((candidate) => candidate.id === id)
  if (!sign) throw new OpError('not_found', `No sign has the id "${id}".`, 'List the signs with signage_get.')
  return sign
}

// The sign as stored, or invalid_input naming the range that would fit its wall.
function fitted(walls: readonly Wall[], sign: z.input<typeof Sign>) {
  const problem = misfit(requireWall(walls, sign.wallIndex), sign)
  if (problem) throw new OpError('invalid_input', 'The sign does not fit on its wall.', problem)
  return Sign.parse(sign)
}

const SignResult = Sign.extend({ facingDeg: z.number() })
const WriteResult = z.object({ propertyId: z.string(), version: z.int(), signCount: z.int(), sign: SignResult.nullable() })

// Reads the signs, lets `change` edit them, and saves them one version higher. A stale
// `expectedVersion` answers `conflict` and saves nothing. `change` returns the sign it touched.
function write(ctx: OpContext, id: string, walls: readonly Wall[], expected: number | undefined, change: (document: SignDocument) => Sign | null) {
  return withSignLock(id, async () => {
    const document = await readSigns(ctx.dataDir, id)
    if (expected !== undefined && expected !== document.version) {
      throw new OpError('conflict', 'The signs changed since you read them.', `They are at version ${document.version}. Call signage_get and retry with expectedVersion ${document.version}.`)
    }
    const sign = change(document)
    document.version += 1
    await writeSigns(ctx.dataDir, document)
    const facing = sign && { ...sign, facingDeg: walls[sign.wallIndex].facingDeg }
    return { result: { propertyId: id, version: document.version, signCount: document.signs.length, sign: facing } }
  })
}

const WallBrief = z.object({ index: z.int(), facingDeg: z.number(), lengthM: z.number(), baseM: z.number(), topM: z.number() })

const signageGet = defineOp({
  name: 'signage_get',
  summary: "A commercial building's outside walls and the blank signs placed on them.",
  effect: 'read',
  input: z.object({ propertyId }),
  output: z.object({
    propertyId: z.string(),
    version: z.int(),
    heightM: z.number(),
    walls: z.array(WallBrief).describe(`The walls at least ${LISTED_WALL_M} m long. facingDeg is the compass bearing of the outside face.`),
    signs: z.array(SignResult),
    source: Source,
    assumptions: Assumptions,
  }),
  detail: z.object({
    walls: z.array(z.object({ index: z.int(), volumeId: z.string(), start: Point, end: Point, lengthM: z.number(), facingDeg: z.number(), baseM: z.number(), topM: z.number() })),
  }),
})(async (ctx, input) => {
  const { heightM, walls, source } = await shellOf(ctx, input.propertyId)
  const { version, signs } = await readSigns(ctx.dataDir, input.propertyId)
  return {
    result: {
      propertyId: input.propertyId,
      version,
      heightM,
      walls: walls.filter(({ lengthM }) => lengthM >= LISTED_WALL_M).map(({ index, facingDeg, lengthM, baseM, topM }) => ({ index, facingDeg, lengthM, baseM, topM })),
      signs: signs.map((sign) => ({ ...sign, facingDeg: walls[sign.wallIndex]?.facingDeg ?? 0 })),
      source,
      assumptions: [
        'Walls are the edges of the building outline, extruded from the base to the top of each part.',
        'Heights are above the ground at the building, taken as flat.',
      ],
    },
    detail: { walls: walls.map(({ confidence: _, ...wall }) => wall) },
  }
})

const signagePlace = defineOp({
  name: 'signage_place',
  summary: 'Hangs a blank sign on an outside wall of a commercial building, by wall index or by the way it faces.',
  effect: 'write',
  input: z.object({
    propertyId,
    wallIndex: wallIndex.optional(),
    facingDeg: z.number().min(0).lt(360).optional().describe('Pick the longest wall facing within 45 degrees of this bearing. Send this or wallIndex.'),
    alongM: alongM.optional().describe("The sign's centre in metres from the wall's start corner. The wall's middle when left out."),
    bottomM: bottomM.optional().describe(`The bottom edge in metres above the ground. ${DEFAULT_BOTTOM_M} m above the wall's base when left out.`),
    sizeM: sizeM.optional().describe(`The face in metres. ${DEFAULT_SIZE.widthM} by ${DEFAULT_SIZE.heightM} when left out.`),
    expectedVersion,
  }),
  output: WriteResult,
})(async (ctx, input) => {
  const { walls } = await shellOf(ctx, input.propertyId)
  const size = input.sizeM ?? DEFAULT_SIZE
  if ((input.wallIndex === undefined) === (input.facingDeg === undefined)) {
    throw new OpError('invalid_input', 'Send exactly one of wallIndex and facingDeg.', 'List the walls and their bearings with signage_get.')
  }
  const wall = input.wallIndex !== undefined ? requireWall(walls, input.wallIndex) : wallFacing(walls, input.facingDeg ?? 0, size)
  if (!wall) throw new OpError('not_found', `No wall faces within 45 degrees of ${input.facingDeg} and fits this sign.`, 'List the walls and their bearings with signage_get.')
  const sign = fitted(walls, {
    id: `s-${randomBytes(3).toString('hex')}`,
    wallIndex: wall.index,
    alongM: input.alongM ?? wall.lengthM / 2,
    bottomM: input.bottomM ?? Math.min(wall.baseM + DEFAULT_BOTTOM_M, wall.topM - size.heightM),
    sizeM: size,
  })
  return write(ctx, input.propertyId, walls, input.expectedVersion, (document) => {
    if (document.signs.length >= MAX_SIGNS) throw new OpError('invalid_input', `A property holds at most ${MAX_SIGNS} signs.`, 'Remove one with signage_remove first.')
    document.signs.push(sign)
    return sign
  })
})

const signageMove = defineOp({
  name: 'signage_move',
  summary: 'Moves or resizes a placed sign. Fields left out keep their value.',
  effect: 'write',
  input: z.object({ propertyId, signId, wallIndex: wallIndex.optional(), alongM: alongM.optional(), bottomM: bottomM.optional(), sizeM: sizeM.optional(), expectedVersion }),
  output: WriteResult,
})(async (ctx, { propertyId: id, signId: target, expectedVersion: expected, ...change }) => {
  const { walls } = await shellOf(ctx, id)
  return write(ctx, id, walls, expected, (document) => {
    const sign = requireSign(document, target)
    const moved = fitted(walls, {
      ...sign,
      wallIndex: change.wallIndex ?? sign.wallIndex,
      alongM: change.alongM ?? sign.alongM,
      bottomM: change.bottomM ?? sign.bottomM,
      sizeM: change.sizeM ?? sign.sizeM,
    })
    document.signs = document.signs.map((candidate) => (candidate.id === target ? moved : candidate))
    return moved
  })
})

const signageRemove = defineOp({
  name: 'signage_remove',
  summary: 'Takes a placed sign off its wall.',
  effect: 'write',
  input: z.object({ propertyId, signId, expectedVersion }),
  output: WriteResult,
})(async (ctx, { propertyId: id, signId: target, expectedVersion: expected }) => {
  const { walls } = await shellOf(ctx, id)
  return write(ctx, id, walls, expected, (document) => {
    requireSign(document, target)
    document.signs = document.signs.filter((candidate) => candidate.id !== target)
    return null
  })
})

const signageMeasure = defineOp({
  name: 'signage_measure',
  summary: 'The size of a placed sign, its height above the ground and the lift that reaches it.',
  effect: 'read',
  input: z.object({ propertyId, signId }),
  output: z.object({
    signId: z.string(),
    wallIndex: z.int(),
    facingDeg: z.number(),
    widthM: z.number(),
    heightM: z.number(),
    areaM2: z.number(),
    bottomAboveGroundM: z.number(),
    topAboveGroundM: z.number(),
    lift: ReachingLift.nullable(),
    source: Source,
    confidence: Confidence,
    assumptions: Assumptions,
  }),
})(async (ctx, input) => {
  const { walls, source } = await shellOf(ctx, input.propertyId)
  const sign = requireSign(await readSigns(ctx.dataDir, input.propertyId), input.signId)
  const wall = requireWall(walls, sign.wallIndex)
  const { widthM, heightM } = sign.sizeM
  const top = Math.round((sign.bottomM + heightM) * 100) / 100
  const assumptions = [
    'The sign is a blank placeholder. No sign rule, zone or permit was checked.',
    'Heights are above the ground at the building, taken as flat, from the Vexcel outline and height.',
  ]

  let lift: z.input<typeof ReachingLift> | null = null
  if (top <= REACH_FROM_GROUND_M) assumptions.push('A person reaches a sign this low from the ground, so no lift is named.')
  else {
    const chosen = await ctx.call('lift_choose', { heightM: top }).catch((error: unknown) => {
      if (error instanceof OpError && error.code === 'no_data') return null
      throw error
    })
    if (chosen) {
      const found = LiftResult.parse(chosen.result)
      lift = ReachingLift.parse(found)
      assumptions.push(...found.assumptions)
    } else assumptions.push('No lift in the catalogue reaches the top of this sign.')
  }

  return {
    result: {
      signId: sign.id,
      wallIndex: wall.index,
      facingDeg: wall.facingDeg,
      widthM,
      heightM,
      areaM2: Math.round(widthM * heightM * 100) / 100,
      bottomAboveGroundM: sign.bottomM,
      topAboveGroundM: top,
      lift,
      source,
      confidence: wall.confidence,
      assumptions,
    },
  }
})

const wholeM = z.number().overwrite(Math.round)
const Direction = z.enum(['north', 'east', 'south', 'west'])

const signageCamera = defineOp({
  name: 'signage_camera',
  summary: "The camera of a property's oblique photo in the building's frame, so a page can draw walls and signs on it.",
  effect: 'read',
  input: z.object({ propertyId, direction: Direction.describe('The way the camera looks.') }),
  output: z.object({
    direction: Direction,
    widthPx: z.int(),
    heightPx: z.int(),
    camera: z.array(z.number()).length(12).describe('The 3x4 projection, row-major, from building metres [x east, y north, z up, 1] to photo pixels from the top left.'),
    centreM: z.tuple([wholeM, wholeM, wholeM]).describe('Where the camera stood in building metres.'),
    source: z.literal('vexcel'),
    confidence: Confidence,
    assumptions: Assumptions,
  }),
})(async (ctx, input) => {
  const { property, origin } = await shellOf(ctx, input.propertyId)
  const { photo } = await ctx.vexcel.oblique(property, input.direction).catch((error: unknown) => {
    if (error instanceof UpstreamError) throw new OpError('upstream', `Vexcel answered ${error.status}.`, 'Vexcel did not answer. Try again in a minute.')
    throw error
  })
  if (photo.status !== 200) throw new OpError('no_data', `Vexcel has no ${input.direction} photo of this property.`, 'List the directions with GET /api/oblique/:id.')
  const xmp = readObliqueCamera(photo.body)
  const camera = xmp && cameraInFrame(xmp, origin)
  if (!xmp || !camera) throw new OpError('no_data', 'This photo carries no readable camera.', 'Try another direction.')
  return {
    result: {
      direction: input.direction,
      widthPx: camera.widthPx,
      heightPx: camera.heightPx,
      camera: camera.matrix,
      centreM: camera.centreM,
      source: 'vexcel',
      confidence: camera.groundFromPhoto ? 0.6 : 0.9,
      assumptions: [
        "The camera stands where Vexcel measured it (camera-pos in the photo's XMP), and its view is fixed by the ground outline Vexcel gives for the photo.",
        'The lens is a pinhole. The XMP lists every distortion term as zero.',
        'The building frame is flat and ignores the curve of the earth, which shifts a point about 1 m in 4 km.',
        camera.groundFromPhoto
          ? "Vexcel gave no roof elevation for this building, so its base is taken to be at the photo's ground height (ground-z in the XMP). If the base sits higher or lower, walls and signs are drawn that much off."
          : "The ground is flat at the building's base height.",
        'Neighbouring buildings and trees are not modelled, so they may hide a wall that looks open.',
      ],
    },
  }
})

export const SIGNAGE_OPS = [liftChoose, signageGet, signageCamera, signagePlace, signageMove, signageRemove, signageMeasure]

import { z } from 'zod'
import { EQUIPMENT, EQUIPMENT_CLASSES } from '../../model/equipment.ts'
import { Assumptions, defineOp, OpError } from '../op.ts'
import { readScene, SpaceId } from '../scene/document.ts'
import { chooseLift, TALLEST_LIFT } from './lift.ts'
import { measureSign } from './measure.ts'

// A person standing on the ground reaches a sign whose top is this low.
const REACH_FROM_GROUND_M = 2

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

const MeasureResult = z.object({
  spaceId: SpaceId,
  objectId: z.string(),
  widthM: z.number(),
  heightM: z.number(),
  areaM2: z.number(),
  bottomAboveGroundM: z.number().nullable(),
  topAboveGroundM: z.number().nullable(),
  lift: ReachingLift.nullable(),
  source: z.literal('mesh'),
  assumptions: Assumptions,
})

const signageMeasure = defineOp({
  name: 'signage_measure',
  summary: 'The size of a placed sign, its height above the ground and the lift that reaches it.',
  effect: 'read',
  input: z.object({ spaceId: SpaceId, objectId: z.string().describe('A placed sign id from scene_get.') }),
  output: MeasureResult,
})(async (ctx, { spaceId, objectId }) => {
  const { objects } = await readScene(ctx.dataDir, spaceId)
  const object = objects.find(({ id }) => id === objectId)
  if (!object) throw new OpError('not_found', `No placed object has the id "${objectId}".`, 'List the placed objects with scene_get.')
  const { sizeM } = object
  if (!sizeM || EQUIPMENT.find(({ id }) => id === object.equipmentId)?.class !== 'sign') {
    throw new OpError('invalid_input', 'This object is not a sign.', 'Place a sign_panel with scene_place first.')
  }

  const { groundProblem, ...measures } = measureSign({ ...object, sizeM })
  const assumptions = ['The sign is a blank placeholder. No sign rule, zone or permit was checked.']
  if (groundProblem) assumptions.push("The measured ground is above the sign's bottom edge, so the heights are left out.")
  else if (measures.topAboveGroundM === null) {
    assumptions.push('The ground under this sign is not measured yet. Open the space in the Signage panel, or send groundY with scene_move.')
  }

  let lift: z.input<typeof ReachingLift> | null = null
  const top = measures.topAboveGroundM
  if (top !== null && top <= REACH_FROM_GROUND_M) assumptions.push(`A person reaches a sign this low from the ground, so no lift is named.`)
  else if (top !== null) {
    const chosen = await ctx.call('lift_choose', { heightM: top }).catch((error: unknown) => {
      if (error instanceof OpError && error.code === 'no_data') return null
      throw error
    })
    if (chosen) {
      const found = LiftResult.parse(chosen.result)
      lift = ReachingLift.parse(found)
      assumptions.push(...found.assumptions)
    }
    else assumptions.push('No lift in the catalogue reaches the top of this sign.')
  }

  return { result: { spaceId, objectId, ...measures, lift, source: 'mesh', assumptions } }
})

export const SIGNAGE_OPS = [liftChoose, signageMeasure]

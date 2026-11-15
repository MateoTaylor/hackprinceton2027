import { z } from 'zod'
import { EQUIPMENT, EQUIPMENT_CLASSES } from '../../model/equipment.ts'
import { defineOp } from '../op.ts'

const metres = z.number().nullable()

const equipmentList = defineOp({
  name: 'equipment_list',
  summary: 'The lifts, vehicles, props and signs in the catalogue, with their sizes in metres.',
  effect: 'read',
  input: z.object({ class: z.enum(EQUIPMENT_CLASSES).optional().describe('Only list items of this class.') }),
  output: z.object({
    items: z.array(
      z.object({
        id: z.string(),
        class: z.enum(EQUIPMENT_CLASSES),
        label: z.string(),
        workingHeightM: metres,
        outreachM: metres,
        widthM: metres,
        lengthM: metres,
        stowedHeightM: metres,
        terrain: z.enum(['slab', 'rough']),
        indoor: z.boolean(),
        mount: z.enum(['floor', 'wall']),
      }),
    ),
  }),
})(async (_ctx, input) => ({
  result: {
    items: EQUIPMENT.filter((row) => !input.class || row.class === input.class),
  },
}))

export const EQUIPMENT_OPS = [equipmentList]

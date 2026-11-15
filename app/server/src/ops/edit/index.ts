import { z } from 'zod'
import { Assumptions, defineOp, OpError, requireProperty, type OpContext } from '../op.ts'
import { dropProperties, EDIT_TOOLS, matchCommand, pictureUrl, readDrop, type EditTool, type PreparedEdit } from './drop.ts'

// The picture ops behind the Magic Eraser and Remodel panels. They hand back edits that were
// prepared ahead of time from a drop folder; no request leaves the laptop. The names avoid the
// `edit_` prefix, which the agent adapter skips because it once meant the edit API.

const propertyId = z.string().describe('A property id from GET /api/properties.')
const tool = z.enum(EDIT_TOOLS).describe('erase removes an object (Magic Eraser). remodel changes a surface, such as a countertop, a floor or a pillow colour.')

const ASSUMPTIONS = [
  'This is a prepared demo edit: the after picture was made ahead of time, not just now.',
  'Only the one panorama in the picture is edited.',
]

const Listed = z.object({
  editId: z.string(),
  tool: z.enum(EDIT_TOOLS),
  command: z.string().describe('The command this edit answers. Pass it to picture_edit_apply.'),
  where: z.string().nullable().describe('The room or view the picture shows.'),
  beforeUrl: z.string(),
})

const brief = (propertyId: string, { id, tool, command, where, before }: PreparedEdit) => ({
  editId: id,
  tool,
  command,
  where: where ?? null,
  beforeUrl: pictureUrl(propertyId, before),
})

// The prepared edits of a property, or an OpError whose hint names the properties that have some.
async function preparedEdits(ctx: OpContext, id: string) {
  requireProperty(ctx, id)
  const drop = await readDrop(ctx.dataDir, id)
  if ('edits' in drop) return drop.edits
  if (drop.problem === 'missing') {
    const ready = await dropProperties(ctx.dataDir)
    throw new OpError('no_data', 'This property has no prepared picture edits.', ready.length ? `Prepared edits exist for ${ready.join(', ')}.` : 'No property has prepared edits yet.')
  }
  throw new OpError('not_ready', 'The prepared edits for this property are not usable yet.', drop.problem === 'invalid' ? 'Fix the drop folder manifest; the edit ops README has its shape.' : 'Add the pictures the drop folder manifest names.')
}

export const pictureEditList = defineOp({
  name: 'picture_edit_list',
  summary: 'The prepared Magic Eraser and Remodel edits of a property, with the command each one answers.',
  effect: 'read',
  input: z.object({ propertyId, tool: tool.optional().describe('Only edits of this tool. Leave it out for both.') }),
  output: z.object({ propertyId: z.string(), edits: z.array(Listed).max(20), assumptions: Assumptions }),
})(async (ctx, input) => {
  const edits = (await preparedEdits(ctx, input.propertyId)).filter((edit) => !input.tool || edit.tool === input.tool)
  return { result: { propertyId: input.propertyId, edits: edits.map((edit) => brief(input.propertyId, edit)), assumptions: ASSUMPTIONS } }
})

const commandList = (edits: readonly PreparedEdit[], wanted: EditTool) =>
  edits
    .filter((edit) => edit.tool === wanted)
    .map(({ command }) => `"${command}"`)
    .join(', ')

export const pictureEditApply = defineOp({
  name: 'picture_edit_apply',
  summary: 'Apply a Magic Eraser or Remodel command to a property scan picture and get the before and after pictures.',
  effect: 'write',
  input: z.object({
    propertyId,
    tool,
    command: z.string().min(3).max(300).describe('What to change, such as "remove the floor lamp" or "make the countertop white marble".'),
  }),
  output: Listed.extend({ afterUrl: z.string(), assumptions: Assumptions }),
})(async (ctx, input) => {
  const edits = await preparedEdits(ctx, input.propertyId)
  const edit = matchCommand(edits, input.tool, input.command)
  if (!edit) {
    const known = commandList(edits, input.tool)
    throw new OpError('no_data', `No prepared ${input.tool} edit matches that command.`, known ? `The prepared ${input.tool} commands are ${known}.` : `This property has no prepared ${input.tool} edits.`)
  }
  return { result: { ...brief(input.propertyId, edit), afterUrl: pictureUrl(input.propertyId, edit.after), assumptions: ASSUMPTIONS } }
})

export const EDIT_OPS = [pictureEditList, pictureEditApply]

export type PictureEditList = z.infer<typeof pictureEditList.output>
export type PictureEdit = z.infer<typeof pictureEditApply.output>

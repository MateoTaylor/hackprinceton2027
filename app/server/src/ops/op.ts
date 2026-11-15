import { z } from 'zod'
import type { Property } from '../../../shared/property.ts'
import type { Matterport } from '../matterport.ts'
import type { BuildingFacts } from '../properties.ts'
import type { Vexcel } from '../vexcel.ts'

// The longest `JSON.stringify(result)` that runOp lets through. Geometry and long lists go in
// `detail`, which has no limit.
export const RESULT_MAX_CHARS = 6000

// Every way an op can fail.
//   invalid_input  the input does not match the op's input schema
//   not_found      an id names nothing; the hint names where valid ids come from
//   not_ready      a build step or a key is missing; the hint names it
//   no_data        the source has nothing for this property
//   upstream       Vexcel, Matterport or the edit API failed
//   conflict       a write lost to a newer version
//   internal       a bug; the message is fixed and says nothing about the cause
export const OP_ERROR_CODES = ['invalid_input', 'not_found', 'not_ready', 'no_data', 'upstream', 'conflict', 'internal'] as const
export type OpErrorCode = (typeof OP_ERROR_CODES)[number]

// Where a derived value came from. `maker` is a manufacturer's spec sheet. `inferred` is our own
// guess and always travels with a Confidence.
export const Source = z.enum(['costar', 'vexcel', 'scan', 'mesh', 'overture', 'maker', 'inferred'])

// How sure a value is, from 0 (a guess) to 1 (a measurement).
export const Confidence = z.number().min(0).max(1)

// The assumptions an op made, as plain sentences a model can repeat to a user.
export const Assumptions = z.array(z.string().min(1).max(200)).max(8)

// The one failure an op throws on purpose. runOp copies code, message and hint into the envelope
// verbatim, so neither string may hold a key, a file path, a URL or a record value.
//   throw new OpError('no_data', 'This property has no scan.', 'Pick a property with a scan.')
export class OpError extends Error {
  readonly code: OpErrorCode
  readonly hint: string

  constructor(code: OpErrorCode, message: string, hint: string) {
    super(message)
    this.name = 'OpError'
    this.code = code
    this.hint = hint
  }
}

// What every op can reach. `matterport` is null when the Matterport keys are missing. Reach it
// through requireMatterport.
//
// `edit` sends one request to the edit API on Mateo's PC, the same way the browser's /api/edit/*
// requests go, so no op holds the token. `path` is the edit API's own path. Without EDIT_API_URL
// and EDIT_API_TOKEN it answers 503 with the code `edit_api_not_configured`:
//   const res = await ctx.edit(`/places/${modelId}`)
//
// `call` runs another op by name with detail on. It resolves to that op's checked result and
// detail as `unknown` and rejects with that op's OpError:
//   const { detail } = await ctx.call('building_get', { propertyId })
export interface OpContext {
  properties: ReadonlyMap<string, Property>
  vexcel: Vexcel
  matterport: Matterport | null
  buildingFacts: ReadonlyMap<string, BuildingFacts>
  dataDir: string
  edit(path: string, init?: RequestInit): Promise<Response>
  call(name: string, input: unknown): Promise<{ result: unknown; detail: unknown }>
}

// What `run` resolves to. It returns `detail` exactly when the op declares a detail schema. Both
// are the schemas' input types, so a field with a default may be left out.
export type OpAnswer<Out extends z.ZodType, Det extends z.ZodType> = Det extends z.ZodNever
  ? { result: z.input<Out> }
  : { result: z.input<Out>; detail: z.input<Det> }

// One op. The bare `Op` is the element type of a list of ops: every op from defineOp assigns to it with
// no cast, because `run` is a method and TypeScript checks method parameters bivariantly. That is
// sound only because runOp parses the input before it calls `run`, so run ops through runOp.
//
// `input` is an object schema, because a tool call's arguments are a JSON object. `output` and
// `detail` must convert with `z.toJSONSchema`, so they hold no transform.
export interface Op<In extends z.ZodObject = z.ZodObject, Out extends z.ZodType = z.ZodType, Det extends z.ZodType = z.ZodType | z.ZodNever> {
  name: string
  summary: string
  effect: 'read' | 'write'
  input: In
  output: Out
  detail?: Det
  run(ctx: OpContext, input: z.output<In>): Promise<OpAnswer<Out, Det>>
}

// Declares an op in two calls, schemas first and `run` second:
//   export const propertyGet = defineOp({ name, summary, effect, input, output })(async (ctx, { propertyId }) => {
//     const { id, name } = requireProperty(ctx, propertyId)
//     return { result: { id, name } }
//   })
// The first call fixes the types from the schemas alone, so `run` is checked against them and its
// literals keep their types. In one object TypeScript infers from `run` too and widens
// `source: 'inferred'` to `string`, which then fails against `Source`.
export const defineOp =
  <In extends z.ZodObject, Out extends z.ZodType, Det extends z.ZodType = z.ZodNever>(meta: Omit<Op<In, Out, Det>, 'run'>) =>
  (run: Op<In, Out, Det>['run']): Op<In, Out, Det> => ({ ...meta, run })

// An op whose name, summary, effect and input are final but whose `run` is not written yet. It
// answers `not_ready` and has an empty output. Replace it with a defineOp call when the op is built:
//   const buildingGet = stubOp({ name: 'building_get', summary, effect: 'read', input })
export const stubOp = <In extends z.ZodObject>(meta: Pick<Op<In>, 'name' | 'summary' | 'effect' | 'input'>) =>
  defineOp({ ...meta, output: z.object({}) })(async () => {
    throw new OpError('not_ready', `${meta.name} is not built yet.`, 'This op is not built yet.')
  })

// What runOp resolves to.
export type OpEnvelope<Result = unknown, Detail = unknown> =
  | { ok: true; result: Result; detail?: Detail }
  | { ok: false; error: { code: OpErrorCode; message: string; hint: string } }

// Runs an op and never throws. A test uses it to check the envelope,
// and calls `op.run` directly to see the real exception behind an `internal`.
//
// The envelope holds what the output schema parsed, not what `run` returned, so a key the schema
// does not name never leaves the server. `detail` is parsed and returned only when
// `options.detail` is true and the op declares one.
export async function runOp<In extends z.ZodObject, Out extends z.ZodType, Det extends z.ZodType>(
  op: Op<In, Out, Det>,
  ctx: OpContext,
  rawInput: unknown,
  options: { detail?: boolean } = {},
): Promise<OpEnvelope<z.output<Out>, z.output<Det>>> {
  const input = op.input.safeParse(rawInput)
  if (!input.success) {
    const [issue] = input.error.issues
    const path = issue.path.map(String).join('.') || 'input'
    return failure('invalid_input', `${path}: ${issue.message}`, `Read the input schema of ${op.name} in GET /api/ops.`)
  }

  let answer: OpAnswer<Out, Det>
  try {
    answer = await op.run(ctx, input.data)
  } catch (error) {
    if (error instanceof OpError) return failure(error.code, error.message, error.hint)
    return internal(op.name, { thrown: error })
  }

  const result = op.output.safeParse(answer.result)
  if (!result.success) return internal(op.name, 'OutputMismatch')
  if (JSON.stringify(result.data).length > RESULT_MAX_CHARS) return internal(op.name, 'ResultTooLarge')

  const schema = op.detail
  if (!options.detail || !schema) return { ok: true, result: result.data }
  const detail = schema.safeParse('detail' in answer ? answer.detail : undefined)
  if (!detail.success) return internal(op.name, 'DetailMismatch')
  return { ok: true, result: result.data, detail: detail.data }
}

function failure(code: OpErrorCode, message: string, hint: string) {
  return { ok: false, error: { code, message, hint } } as const
}

function internal(name: string, cause: 'OutputMismatch' | 'ResultTooLarge' | 'DetailMismatch' | { thrown: unknown }) {
  const reason = typeof cause === 'string' ? cause : cause.thrown instanceof Error ? cause.thrown.constructor.name : typeof cause.thrown
  console.error(`op ${name} failed: ${reason}`)
  return failure('internal', `${name} failed on the server.`, 'This is a bug, not your input. Retrying will not help.')
}

// The Property for an id, or `not_found` with a hint that names GET /api/properties.
export function requireProperty(ctx: Pick<OpContext, 'properties'>, id: string): Property {
  const property = ctx.properties.get(id)
  if (!property) throw new OpError('not_found', `No property has the id "${id}".`, 'List the valid ids with GET /api/properties.')
  return property
}

// The Matterport client, or `not_ready` with a hint that names the two keys it needs.
export function requireMatterport(ctx: Pick<OpContext, 'matterport'>): Matterport {
  if (!ctx.matterport) throw new OpError('not_ready', 'The Matterport client is off.', 'Add MP_TOKEN_ID and MP_TOKEN_SECRET to the repo-root .env and restart the server.')
  return ctx.matterport
}

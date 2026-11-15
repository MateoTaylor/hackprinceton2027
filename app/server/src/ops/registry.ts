import { z } from 'zod'
import { type Op, type OpContext, type OpEnvelope, OpError, runOp } from './op.ts'

const NAME = /^[a-z][a-z0-9_]{2,40}$/

const MAX_CALL_DEPTH = 4

export type OpBase = Omit<OpContext, 'call'>

// One op as GET /api/ops lists it. `input` is the JSON Schema of what a caller sends and `output`
// the JSON Schema of the `result` that comes back, so a model can build its tool from this alone.
export interface OpManifestEntry {
  name: string
  summary: string
  effect: Op['effect']
  input: z.core.JSONSchema.BaseSchema
  output: z.core.JSONSchema.BaseSchema
}

export interface Registry {
  get(name: string): Op | undefined
  manifest(): OpManifestEntry[]
  run(name: string, rawInput: unknown, options?: { detail?: boolean }): Promise<OpEnvelope>
}

class CallDepthExceeded extends Error {}

// Checks the ops once at startup and runs them by name. It throws when a name breaks NAME, a name
// appears twice or a schema does not convert to JSON Schema, so a bad op stops the server from
// starting. `run` answers an unknown name with `not_found`.
export function createRegistry(ops: readonly Op[], base: OpBase): Registry {
  const byName = new Map<string, Op>()
  for (const op of ops) {
    if (!NAME.test(op.name)) throw new Error(`Op name "${op.name}" must match ${NAME}.`)
    if (byName.has(op.name)) throw new Error(`Op "${op.name}" is registered twice.`)
    byName.set(op.name, op)
  }

  const manifest = ops.map(
    (op): OpManifestEntry => ({
      name: op.name,
      summary: op.summary,
      effect: op.effect,
      input: z.toJSONSchema(op.input, { io: 'input' }),
      output: z.toJSONSchema(op.output),
    }),
  )

  const runAt = async (depth: number, name: string, rawInput: unknown, options: { detail?: boolean }): Promise<OpEnvelope> => {
    const op = byName.get(name)
    if (!op) return { ok: false, error: { code: 'not_found', message: `No op is named "${name}".`, hint: 'List the ops with GET /api/ops.' } }
    const call: OpContext['call'] = async (callee, input) => {
      if (depth === MAX_CALL_DEPTH) throw new CallDepthExceeded()
      const answer = await runAt(depth + 1, callee, input, { detail: true })
      if (!answer.ok) throw new OpError(answer.error.code, answer.error.message, answer.error.hint)
      return { result: answer.result, detail: answer.detail }
    }
    return runOp(op, { ...base, call }, rawInput, options)
  }

  return {
    get: (name) => byName.get(name),
    manifest: () => manifest,
    run: (name, rawInput, options = {}) => runAt(0, name, rawInput, options),
  }
}

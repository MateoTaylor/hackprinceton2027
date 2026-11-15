import type { InterruptOnConfig } from 'langchain'
import { dynamicSystemPromptMiddleware, tool } from 'langchain'
import { z } from 'zod'
import type { OpEnvelope, OpErrorCode } from '../../server/src/ops/op.ts'
import type { OpManifestEntry } from '../../server/src/ops/registry.ts'

// The Propstar ops as Proppy sees them: the manifest from GET /api/ops and a way to run one.
// `call` never rejects; a request that fails resolves to an `upstream` error envelope.
export interface Ops {
  manifest: OpManifestEntry[]
  call(name: string, input: unknown): Promise<OpEnvelope>
}

// The Propstar API on this laptop. PROPSTAR_PORT moves it off 8787.
export const propstarUrl = () => `http://127.0.0.1:${process.env.PROPSTAR_PORT ?? 8787}`

export const API_UNREACHABLE = 'The Propstar API is not reachable.'

const UNANSWERED: OpEnvelope = {
  ok: false,
  error: { code: 'upstream', message: 'The Propstar API did not answer.', hint: 'Start the Propstar API with `pnpm --dir app/server start`.' },
}

// The two answers the API sends, checked at the boundary. Both come from our own server, so the
// checks stop at the fields Proppy reads.
const Manifest = z.object({
  ops: z.array(
    z.object({
      name: z.string(),
      summary: z.string(),
      effect: z.enum(['read', 'write', 'view']),
      input: z.custom<OpManifestEntry['input']>((v) => typeof v === 'object' && v !== null),
      output: z.custom<OpManifestEntry['output']>((v) => typeof v === 'object' && v !== null),
    }),
  ),
})

const Envelope = z.union([
  z.object({ ok: z.literal(true), result: z.unknown(), detail: z.unknown().optional() }),
  z.object({
    ok: z.literal(false),
    error: z.object({ code: z.custom<OpErrorCode>((v) => typeof v === 'string'), message: z.string(), hint: z.string() }),
  }),
])

// Reads the manifest once under a 3 s timeout and rejects with API_UNREACHABLE when the API is off.
//   const ops = await connectOps(propstarUrl())
export async function connectOps(baseUrl: string): Promise<Ops> {
  const res = await fetch(`${baseUrl}/api/ops`, { signal: AbortSignal.timeout(3000) }).catch(() => undefined)
  const manifest = res?.ok ? Manifest.safeParse(await res.json().catch(() => null)) : undefined
  if (!manifest?.success) throw new Error(API_UNREACHABLE)
  return {
    manifest: manifest.data.ops,
    call: async (name, input) => {
      try {
        const answer = await fetch(`${baseUrl}/api/ops/${encodeURIComponent(name)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-propstar-client': 'agent' },
          body: JSON.stringify(input ?? {}),
        })
        const envelope = Envelope.safeParse(await answer.json())
        return envelope.success ? envelope.data : UNANSWERED
      } catch {
        return UNANSWERED
      }
    },
  }
}

// What a model reads back from an op. An error is text with its hint, so the model can correct
// its call instead of the run failing.
export const opText = (answer: OpEnvelope) =>
  answer.ok ? JSON.stringify(answer.result) : `${answer.error.code}: ${answer.error.message} Hint: ${answer.error.hint}`

// One tool per manifest entry that `keep` accepts, named after the op and described by its summary.
//   opTools(ops, (op) => op.effect === 'read')
export const opTools = (ops: Ops, keep: (op: OpManifestEntry) => boolean = () => true) =>
  ops.manifest.filter(keep).map((op) =>
    tool(async (input) => opText(await ops.call(op.name, input)), { name: op.name, description: op.summary, schema: op.input }),
  )

// The interruptOn map: every `write` op waits for the user to approve or reject it.
export const approvals = (ops: Ops): Record<string, InterruptOnConfig> =>
  Object.fromEntries(
    ops.manifest.filter((op) => op.effect === 'write').map((op) => [op.name, { allowedDecisions: ['approve', 'reject'], description: op.summary }]),
  )

export const VIEW_UNAVAILABLE = '\n\nThe view is unavailable.\n\n'

// The part of view_get the note keeps. Leaving out `version` and the highlight list keeps the
// system message stable while scores post, so the prompt cache holds during a run. `aim` passes
// through when the server adds it.
const ViewNote = z.object({
  screen: z.unknown(),
  camera: z.unknown(),
  inView: z.unknown(),
  filter: z.unknown(),
  highlightCount: z.number(),
  aim: z.unknown().optional(),
})

// Adds "What the user sees now:" and one JSON line to every model call's system message, as its
// own paragraph after the prompt.
export const viewNote = (ops: Ops) =>
  dynamicSystemPromptMiddleware(async () => {
    if (!ops.manifest.some((op) => op.name === 'view_get')) return VIEW_UNAVAILABLE
    const answer = await ops.call('view_get', {})
    const note = answer.ok ? ViewNote.safeParse(answer.result) : undefined
    return note?.success ? `\n\nWhat the user sees now:\n${JSON.stringify(note.data)}\n\n` : VIEW_UNAVAILABLE
  })

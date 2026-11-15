import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { BaseCheckpointSaver } from '@langchain/langgraph'
import { CompositeBackend, FilesystemBackend, createDeepAgent, type SubAgent } from 'deepagents'
import { createMiddleware, providerStrategy, tool } from 'langchain'
import { z } from 'zod'
import { PropertyScore } from './contract.ts'
import { approvals, connectOps, opTools, propstarUrl, viewNote, type Ops } from './ops.ts'

const agentDir = fileURLToPath(new URL('..', import.meta.url))
const agentFsDir = path.join(agentDir, '..', '..', 'data', 'propstar', 'agent-fs')
const skillsDir = path.join(agentDir, 'skills')

// A provider-prefixed string resolves on the first model call, so the server boots without a key.
const MODEL = process.env.PROPPY_MODEL ?? 'anthropic:claude-sonnet-5-5'

// Anthropic's server-side web search. The API runs it, so it needs no handler here; the
// @langchain/anthropic adapter passes any `web_search_*` type through untouched.
const WEB_SEARCH = { type: 'web_search_20260209', name: 'web_search', max_uses: 5 }

// Ops the scorer never gets: it scores the property it was handed, so it neither searches the
// whole set nor reads the screen.
const SCORER_SKIPS = new Set(['view_get', 'property_query'])

const viewAerial = tool(
  async ({ propertyId }) => {
    const response = await fetch(`${propstarUrl()}/api/thumb/${encodeURIComponent(propertyId)}`).catch(() => undefined)
    if (!response) return 'The Propstar API is not running, so no aerial image is available.'
    if (!response.ok) return `No aerial image for ${propertyId} (HTTP ${response.status}).`
    return [
      { type: 'text', text: `Vexcel ortho of ${propertyId}, 256 by 256 pixels, north up.` },
      {
        type: 'image',
        mimeType: (response.headers.get('content-type') ?? 'image/jpeg').split(';')[0].trim(),
        data: Buffer.from(await response.arrayBuffer()).toString('base64'),
      },
    ]
  },
  {
    name: 'view_aerial',
    description: 'See the Vexcel aerial ortho of one property: roof, parking, kerbs and paths around the entrances.',
    schema: z.object({ propertyId: z.string() }),
  },
)

// Posts the scorer's PropertyScore as one highlight, so its pin colours as soon as it lands. A
// response that does not parse posts nothing and the pin stays unscored.
const postScore = (ops: Ops) =>
  createMiddleware({
    name: 'PostScore',
    afterAgent: async (state) => {
      const parsed = PropertyScore.safeParse(state.structuredResponse)
      if (!parsed.success) return
      const { propertyId, score, summary } = parsed.data
      await ops.call('view_highlight', { mode: 'add', items: [{ propertyId, score, note: summary.slice(0, 80) }] })
    },
  })

const COORDINATOR_PROMPT = `You are Proppy, the property scout inside Propstar, a map of CoStar properties in Los Angeles and Houston.
Your tools are Propstar's ops. Each op's description says what it does. A note below, headed "What the user sees now", says what is on screen.

For a question about which properties fit:
1. Read the matching skill under /skills/ first.
2. Find candidates with property_query, following the property-search skill.
3. Score each row from its columns, as the matching skill says. Say the score is a first pass from the record.
4. Post every score with one view_highlight call in replace mode.
5. Fit the map around them with view_frame.
6. Answer with the best matches first and what each score rests on.

Send a task to score-property only when the user focuses on one property and asks for a deeper look. Never fan out one task per property.
The area ops are your maps. Use area_summary, area_places and area_roads for what is around a property: restaurants and other places by group, the street it fronts and the nearest highway. Follow the property-search skill.
Use web_search only for facts outside Propstar, such as a local rule or a neighbourhood. Say what came from the web.
A write op asks the user first. If the user rejects it, say that nothing changed.
Repeat every assumption an op returned, and every source and confidence you relied on. Never invent evidence.
An op error ends with a hint. Follow the hint and try again once, or tell the user what is missing.`

const SCORER_PROMPT = `You score exactly one property against the user's question.

1. Read the matching skill under /skills/ for the criteria.
2. Call property_get first.
3. Call the other ops the skill names for one property in focus, and view_aerial for the aerial.
4. Stop after 8 tool calls and return a PropertyScore. Cite only what an op returned. Each evidence item names its source.
If an op fails, score from what you have and say what was missing.`

export interface ProppyOptions {
  ops: Ops
  model?: string | BaseChatModel
  subagentModel?: string | BaseChatModel
  checkpointer?: BaseCheckpointSaver
}

// Builds the Proppy graph on a connected set of ops. Tests pass invented ops, fake models and a
// MemorySaver; the LangGraph server goes through `graph` and supplies its own checkpointer.
export function createProppy({ ops, model = MODEL, subagentModel = model, checkpointer }: ProppyOptions) {
  mkdirSync(agentFsDir, { recursive: true })

  const scoreProperty: SubAgent = {
    name: 'score-property',
    description: 'Studies one property in depth against the user question: its record, aerial, building model and routes. Only for one property the user focused on.',
    systemPrompt: SCORER_PROMPT,
    model: subagentModel,
    tools: [...opTools(ops, (op) => op.effect === 'read' && !SCORER_SKIPS.has(op.name)), viewAerial],
    skills: ['/skills/'],
    middleware: [postScore(ops)],
    // Native structured output, because Sonnet 5.5 rejects the forced tool choice that the tool
    // strategy sends. That API also rejects numeric bounds, so the wire schema drops the 0 to 100
    // range and PostScore still checks it.
    responseFormat: providerStrategy(
      PropertyScore.extend({ score: z.number().describe('0 to 100. 0 is unusable for the question, 100 is ideal') }),
    ),
  }

  return createDeepAgent({
    name: 'proppy',
    model,
    systemPrompt: COORDINATOR_PROMPT,
    tools: [...opTools(ops), WEB_SEARCH],
    subagents: [scoreProperty],
    skills: ['/skills/'],
    middleware: [viewNote(ops)],
    interruptOn: approvals(ops),
    backend: new CompositeBackend(new FilesystemBackend({ rootDir: agentFsDir, virtualMode: true }), {
      '/skills/': new FilesystemBackend({ rootDir: skillsDir, virtualMode: true }),
    }),
    permissions: [{ operations: ['write'], paths: ['/skills/**'], mode: 'deny' }],
    checkpointer,
  })
}

// Wraps a build so every call shares one promise, and a build that rejects runs again next call.
export function cached<T>(build: () => Promise<T>) {
  let pending: Promise<T> | undefined
  return () =>
    (pending ??= build().catch((error: unknown) => {
      pending = undefined
      throw error
    }))
}

// The export langgraph.json names. The server calls it on every run and state read, so the
// manifest is read once and a server started before the API connects on the next run.
export const graph = cached(async () => createProppy({ ops: await connectOps(propstarUrl()) }))

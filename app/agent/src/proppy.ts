import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DuckDBInstance, StatementType, type DuckDBConnection } from '@duckdb/node-api'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { AIMessage, type BaseMessage } from '@langchain/core/messages'
import type { BaseCheckpointSaver } from '@langchain/langgraph'
import { CompositeBackend, FilesystemBackend, createDeepAgent, type SubAgent } from 'deepagents'
import { createMiddleware, tool, type ToolRuntime } from 'langchain'
import { z } from 'zod'
import { PropertyScore, type PinEvent } from './contract.ts'

const agentDir = fileURLToPath(new URL('..', import.meta.url))
const dataDir = path.join(agentDir, '..', '..', 'data', 'propstar')
const dbPath = path.join(dataDir, 'propstar.duckdb')
const agentFsDir = path.join(dataDir, 'agent-fs')
const skillsDir = path.join(agentDir, 'skills')
const THUMB_URL = 'http://127.0.0.1:8787/api/thumb'
const MAX_ROWS = 100

// A provider-prefixed string resolves on the first model call, so the server boots without a key.
const MODEL = process.env.PROPPY_MODEL ?? 'anthropic:claude-sonnet-5-5'

// External access off stops `read_text('../../.env')` and friends; the lock stops SQL turning it
// back on. One read-only connection per process, opened on first use so a missing file is a tool
// error rather than a crash at boot.
let connection: Promise<DuckDBConnection> | undefined
function db() {
  connection ??= DuckDBInstance.create(dbPath, {
    access_mode: 'READ_ONLY',
    enable_external_access: 'false',
    lock_configuration: 'true',
  })
    .then((instance) => instance.connect())
    .catch((error: unknown) => {
      connection = undefined
      throw error
    })
  return connection
}

export const queryProperties = tool(
  async ({ sql }) => {
    try {
      const conn = await db()
      const extracted = await conn.extractStatements(sql)
      if (extracted.count !== 1 || (await extracted.prepare(0)).statementType !== StatementType.SELECT) {
        return 'Refused. Send one SELECT or WITH statement.'
      }
      // The newline stops a trailing `-- comment` from swallowing the closing parenthesis.
      const statement = sql.trim().replace(/;+$/, '')
      const reader = await conn.runAndReadAll(`SELECT * FROM (${statement}\n) LIMIT ${MAX_ROWS + 1}`)
      const rows = reader.getRowObjectsJson()
      return JSON.stringify({ rows: rows.slice(0, MAX_ROWS), truncated: rows.length > MAX_ROWS })
    } catch (error) {
      return `SQL error. ${error instanceof Error ? error.message : String(error)}`
    }
  },
  {
    name: 'query_properties',
    description:
      'Run one read-only SELECT over DuckDB and get up to 100 rows as JSON. Tables: ' +
      'properties(id, kind, costar_id, name, address, lat, lon, type_label, photo_url, ' +
      'facts STRUCT(label, value)[], scans STRUCT(model_id, name)[], year_built, building_sf, units, ' +
      'stories, beds, baths, price_usd, rent_usd_month) and scans(property_id, model_id, name). ' +
      "kind is 'commercial' or 'residential'.",
    schema: z.object({ sql: z.string().describe('A single SELECT or WITH statement') }),
  },
)

const getProperty = tool(
  async ({ propertyId }, runtime: ToolRuntime) => {
    runtime.writer?.({ type: 'pin', propertyId, status: 'scoring' } satisfies PinEvent)
    try {
      const reader = await (await db()).runAndReadAll('SELECT * FROM properties WHERE id = $id', { id: propertyId })
      const [row] = reader.getRowObjectsJson()
      return row ? JSON.stringify(row) : `No property has id ${propertyId}.`
    } catch (error) {
      return `Could not load ${propertyId}. ${error instanceof Error ? error.message : String(error)}`
    }
  },
  {
    name: 'get_property',
    description: 'Load the full CoStar record for one property: facts, size, storeys, year built and scan list.',
    schema: z.object({ propertyId: z.string() }),
  },
)

const viewAerial = tool(
  async ({ propertyId }) => {
    const response = await fetch(`${THUMB_URL}/${encodeURIComponent(propertyId)}`).catch(() => undefined)
    if (!response) return 'The Propstar server on 127.0.0.1:8787 is not running, so no aerial image is available.'
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

// Only records the request. The fly-through owns placement; interruptOn asks the user first.
const placeObject = tool(async ({ propertyId, object }) => JSON.stringify({ requested: true, propertyId, object }), {
  name: 'place_object',
  description: 'Ask to place an interactive object, such as a scissor lift or a grand piano, inside a property scan.',
  schema: z.object({ propertyId: z.string(), object: z.string().describe('What to place, in plain words') }),
})

// The pin turned "scoring" when get_property ran, so that call's id is the pin to settle.
const scoringId = (messages: BaseMessage[]) =>
  messages
    .flatMap((m) => (AIMessage.isInstance(m) ? (m.tool_calls ?? []) : []))
    .find((call) => call.name === 'get_property')?.args.propertyId as string | undefined

// Settles the pin when the scorer ends: "scored" with a valid PropertyScore, otherwise "failed".
const pinOutcome = createMiddleware({
  name: 'PinOutcome',
  wrapModelCall: async (request, handler) => {
    try {
      return await handler(request)
    } catch (error) {
      const propertyId = scoringId(request.messages)
      if (propertyId) request.runtime.writer?.({ type: 'pin', propertyId, status: 'failed' } satisfies PinEvent)
      throw error
    }
  },
  afterAgent: (state, runtime) => {
    const parsed = PropertyScore.safeParse(state.structuredResponse)
    const propertyId = parsed.success ? parsed.data.propertyId : scoringId(state.messages)
    if (!propertyId) return
    const pin: PinEvent = parsed.success
      ? { type: 'pin', propertyId, status: 'scored', score: parsed.data.score }
      : { type: 'pin', propertyId, status: 'failed' }
    runtime.writer?.(pin)
  },
})

const COORDINATOR_PROMPT = `You are Proppy, the property scout inside Propstar, a map of CoStar properties in Houston and Los Angeles.
The user asks a question about the properties, such as "which of these are wheelchair-friendly?".

1. Narrow the candidates with query_properties. Keep the list short, 10 at most, unless the user asks for more.
2. Call the task tool once per candidate with subagent_type "score-property", all in the same turn so they run in parallel. Put the property id and the user's question in each description.
3. Each task returns a PropertyScore as JSON. Answer with the best matches first and say what the evidence showed. Never invent evidence the scores do not contain.

Use place_object only when the user asks to put an object in a scan. The user approves each placement.
Skills under /skills/ hold the domain criteria. Read the matching skill before you choose candidates.`

const SCORER_PROMPT = `You score exactly one property against the user's question.

1. Read the matching skill under /skills/ for the criteria.
2. Call get_property once for the CoStar record.
3. Call view_aerial once for the aerial image. If it fails, score from the record and say the aerial was missing.
4. Return a PropertyScore. Cite only what you saw. Each evidence item names its source.

You cannot read Matterport panoramas yet. The record lists scans, but do not claim anything about the interior from them.`

// Builds the Proppy graph. The LangGraph server calls it with no arguments and supplies its own
// checkpointer; tests pass fake models and a MemorySaver.
export function createProppy({
  model = MODEL,
  subagentModel = model,
  checkpointer,
}: { model?: string | BaseChatModel; subagentModel?: string | BaseChatModel; checkpointer?: BaseCheckpointSaver } = {}) {
  mkdirSync(agentFsDir, { recursive: true })

  const scoreProperty: SubAgent = {
    name: 'score-property',
    description: 'Scores one property against the user question from its CoStar record and aerial image.',
    systemPrompt: SCORER_PROMPT,
    model: subagentModel,
    tools: [getProperty, viewAerial],
    skills: ['/skills/'],
    middleware: [pinOutcome],
    responseFormat: PropertyScore,
  }

  return createDeepAgent({
    name: 'proppy',
    model,
    systemPrompt: COORDINATOR_PROMPT,
    tools: [queryProperties, placeObject],
    subagents: [scoreProperty],
    skills: ['/skills/'],
    interruptOn: { place_object: { allowedDecisions: ['approve', 'reject'] } },
    backend: new CompositeBackend(new FilesystemBackend({ rootDir: agentFsDir, virtualMode: true }), {
      '/skills/': new FilesystemBackend({ rootDir: skillsDir, virtualMode: true }),
    }),
    permissions: [{ operations: ['write'], paths: ['/skills/**'], mode: 'deny' }],
    checkpointer,
  })
}

export const graph = createProppy()

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages'
import { fakeModel } from '@langchain/core/testing'
import { Command, MemorySaver } from '@langchain/langgraph'
import type { OpEnvelope } from '../../server/src/ops/op.ts'
import type { OpManifestEntry } from '../../server/src/ops/registry.ts'
import { VIEW_UNAVAILABLE, opTools, type Ops } from './ops.ts'
import { cached, createProppy } from './proppy.ts'

const schema: OpManifestEntry['input'] = { type: 'object', properties: { propertyId: { type: 'string' } }, required: ['propertyId'] }

const entry = (name: string, effect: OpManifestEntry['effect']): OpManifestEntry => ({
  name,
  summary: `${name} summary`,
  effect,
  input: schema,
  output: {},
})

const VIEW = {
  version: 7,
  screen: 'map',
  camera: { center: [-95.37, 29.76], zoom: 12 },
  bounds: null,
  inView: { count: 2, propertyIds: ['p1', 'p2'] },
  filter: null,
  highlightCount: 0,
  highlights: [],
  attached: true,
}

// Invented ops that record every call. `answers` overrides an op's envelope by name.
function fakeOps(names: [string, OpManifestEntry['effect']][], answers: Record<string, OpEnvelope> = {}) {
  const calls: { name: string; input: unknown }[] = []
  const ops: Ops = {
    manifest: names.map(([name, effect]) => entry(name, effect)),
    call: async (name, input) => {
      calls.push({ name, input })
      return answers[name] ?? { ok: true, result: name === 'view_get' ? VIEW : { name } }
    },
  }
  return { ops, calls }
}

const FULL: [string, OpManifestEntry['effect']][] = [
  ['property_get', 'read'],
  ['scene_place', 'write'],
  ['view_get', 'read'],
  ['view_highlight', 'view'],
]

const toolMessages = (messages: BaseMessage[], name: string) =>
  messages.filter((m): m is ToolMessage => ToolMessage.isInstance(m) && m.name === name)

const ask = (content: string) => ({ messages: [{ role: 'user', content }] })

test('every manifest entry becomes a tool named after its op', () => {
  const { ops } = fakeOps(FULL)
  assert.deepEqual(
    opTools(ops).map((t) => t.name),
    FULL.map(([name]) => name),
  )
})

test('an error envelope reaches the model as text with its code and hint', async () => {
  const { ops } = fakeOps(FULL, {
    property_get: { ok: false, error: { code: 'not_found', message: 'No property p9.', hint: 'Find ids with property_query.' } },
  })
  const coordinator = fakeModel()
    .respondWithTools([{ name: 'property_get', args: { propertyId: 'p9' } }])
    .respond(new AIMessage('done'))
  const { messages } = await createProppy({ ops, model: coordinator, checkpointer: new MemorySaver() }).invoke(ask('p9?'), {
    configurable: { thread_id: 'error' },
  })
  assert.equal(toolMessages(messages, 'property_get')[0].text, 'not_found: No property p9. Hint: Find ids with property_query.')
})

test('the filesystem refuses paths that climb out of agent-fs', async () => {
  const { ops } = fakeOps(FULL)
  const coordinator = fakeModel()
    .respondWithTools([{ name: 'read_file', args: { file_path: '/../../.env' } }])
    .respond(new AIMessage('done'))
  const { messages } = await createProppy({ ops, model: coordinator, checkpointer: new MemorySaver() }).invoke(ask('read the env'), {
    configurable: { thread_id: 'fs' },
  })
  assert.match(toolMessages(messages, 'read_file')[0].text, /must not contain "\.\."/)
})

for (const decision of ['approve', 'reject'] as const) {
  test(`a write op waits for the user, and ${decision} ${decision === 'approve' ? 'runs it once' : 'never runs it'}`, async () => {
    const { ops, calls } = fakeOps(FULL)
    const coordinator = fakeModel()
      .respondWithTools([{ name: 'scene_place', args: { propertyId: 'p1' } }])
      .respond(new AIMessage('done'))
    const agent = createProppy({ ops, model: coordinator, checkpointer: new MemorySaver() })
    const config = { configurable: { thread_id: decision } }
    const first = await agent.invoke(ask('place a lift'), config)
    assert.match(JSON.stringify(first.__interrupt__), /"name":"scene_place"/)
    assert.equal(calls.filter((c) => c.name === 'scene_place').length, 0, 'nothing placed before the decision')

    await agent.invoke(new Command({ resume: { decisions: [{ type: decision }] } }), config)
    assert.equal(calls.filter((c) => c.name === 'scene_place').length, decision === 'approve' ? 1 : 0)
  })
}

test('the system message holds the view note, or says the view is unavailable', async () => {
  for (const [names, expected] of [
    [FULL, /What the user sees now:\n\{"screen":"map".*"highlightCount":0\}\n\n/],
    [FULL.filter(([name]) => name !== 'view_get'), /The view is unavailable\.\n\n/],
  ] as const) {
    const { ops } = fakeOps([...names])
    const coordinator = fakeModel().respond(new AIMessage('done'))
    await createProppy({ ops, model: coordinator, checkpointer: new MemorySaver() }).invoke(ask('hi'), {
      configurable: { thread_id: String(names.length) },
    })
    const system = coordinator.calls[0].messages.find((m) => m.type === 'system')?.text ?? ''
    assert.match(system, expected)
    assert.doesNotMatch(system, /"version"/)
  }
  assert.equal(VIEW_UNAVAILABLE.trim(), 'The view is unavailable.')
})

const call = (name: string, args: Record<string, unknown>) => () =>
  new AIMessage({ content: '', tool_calls: [{ name, args, id: `${name}-call` }] })

// Runs one score-property task whose model takes the given turns, approving every interrupt, and
// returns every op call made with the error that ended the run, if one did.
async function scoreOne(scorerTurns: (() => AIMessage)[]) {
  const { ops, calls } = fakeOps(FULL)
  const coordinator = fakeModel()
    .respondWithTools([{ name: 'task', args: { subagent_type: 'score-property', description: 'Score p1 for wheelchair access' } }])
    .respond(new AIMessage('done'))
  const scorer = fakeModel()
  for (const turn of scorerTurns) scorer.respond(turn)
  const agent = createProppy({ ops, model: coordinator, subagentModel: scorer, checkpointer: new MemorySaver() })
  const config = { configurable: { thread_id: 'score' } }
  try {
    let result = await agent.invoke(ask('how about p1?'), config)
    while (result.__interrupt__) result = await agent.invoke(new Command({ resume: { decisions: [{ type: 'approve' }] } }), config)
    return { calls, error: undefined }
  } catch (error) {
    return { calls, error }
  }
}

test('the scorer has no write or view op, even when a write is approved', async () => {
  const { calls, error } = await scoreOne([
    call('scene_place', { propertyId: 'p1' }),
    call('view_highlight', { propertyId: 'p1' }),
    call('PropertyScore', { propertyId: 'p1', score: 50, summary: 'Unknown.', evidence: [] }),
  ])
  assert.equal(error, undefined)
  assert.equal(calls.filter((c) => c.name === 'scene_place').length, 0)
  assert.equal(calls.filter((c) => c.name === 'view_highlight').length, 1, 'only postScore posts')
})

test('a valid PropertyScore posts one highlight', async () => {
  const summary = 'Level entry from the street and a lift to every storey, per the scan.'.repeat(2)
  const { calls, error } = await scoreOne([
    call('property_get', { propertyId: 'p1' }),
    call('PropertyScore', { propertyId: 'p1', score: 72, summary, evidence: [{ source: 'costar', detail: 'One storey.' }] }),
  ])
  assert.equal(error, undefined)
  assert.deepEqual(
    calls.filter((c) => c.name === 'view_highlight').map((c) => c.input),
    [{ mode: 'add', items: [{ propertyId: 'p1', score: 72, note: summary.slice(0, 80) }] }],
  )
})

test('an invalid PropertyScore posts nothing', async () => {
  const { calls, error } = await scoreOne([
    call('PropertyScore', { propertyId: 'p1', score: 140, summary: 'Too high.', evidence: [] }),
    () => {
      throw new Error('model overloaded')
    },
  ])
  assert.match(String(error), /model overloaded/)
  assert.equal(calls.filter((c) => c.name === 'view_highlight').length, 0)
})

test('cached builds once, and builds again after a reject', async () => {
  let builds = 0
  const fail = cached(async () => {
    builds++
    throw new Error('off')
  })
  await assert.rejects(fail(), /off/)
  await assert.rejects(fail(), /off/)
  assert.equal(builds, 2)

  let made = 0
  const once = cached(async () => ++made)
  assert.deepEqual(await Promise.all([once(), once()]), [1, 1])
  assert.equal(await once(), 1)
})

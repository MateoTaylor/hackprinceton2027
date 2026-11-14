import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages'
import { fakeModel } from '@langchain/core/testing'
import { Command, MemorySaver } from '@langchain/langgraph'
import { PropertyScore, type PinEvent } from './contract.ts'
import { createProppy, queryProperties } from './proppy.ts'

const toolMessages = (messages: BaseMessage[], name: string) =>
  messages.filter((m): m is ToolMessage => ToolMessage.isInstance(m) && m.name === name)

test('query_properties reads rows and refuses writes and file access', async () => {
  const { rows } = JSON.parse(await queryProperties.invoke({ sql: 'SELECT id FROM properties LIMIT 2;' }))
  assert.equal(rows.length, 2)

  assert.match(await queryProperties.invoke({ sql: 'DELETE FROM properties' }), /^Refused/)
  assert.match(await queryProperties.invoke({ sql: 'SELECT 1; DROP TABLE properties' }), /^Refused/)
  assert.match(await queryProperties.invoke({ sql: 'SELECT 1) t; CALL pragma_version(); SELECT (1' }), /^SQL error. Failed to extract/)
  const commented = JSON.parse(await queryProperties.invoke({ sql: 'SELECT id FROM properties -- every row' }))
  assert.ok(commented.rows.length > 0)

  const canary = path.join(mkdtempSync(path.join(tmpdir(), 'proppy-')), 'canary.txt')
  writeFileSync(canary, 'canary-secret')
  const read = await queryProperties.invoke({ sql: `SELECT content FROM read_text('${canary}')` })
  assert.doesNotMatch(read, /canary-secret/)
  assert.match(read, /^SQL error/)
})

test('the filesystem refuses paths that climb out of agent-fs', async () => {
  const coordinator = fakeModel()
    .respondWithTools([{ name: 'read_file', args: { file_path: '/../../.env' } }])
    .respond(new AIMessage('done'))
  const agent = createProppy({ model: coordinator, checkpointer: new MemorySaver() })
  const { messages } = await agent.invoke(
    { messages: [{ role: 'user', content: 'read the env' }] },
    { configurable: { thread_id: 'fs' } },
  )
  assert.match(toolMessages(messages, 'read_file')[0].text, /must not contain "\.\."/)
})

test('two parallel scores colour pins, and place_object waits for approval', async () => {
  const { rows } = JSON.parse(await queryProperties.invoke({ sql: 'SELECT id FROM properties ORDER BY id LIMIT 2' }))
  const ids: string[] = rows.map((r: { id: string }) => r.id)

  const coordinator = fakeModel()
    .respondWithTools([{ name: 'query_properties', args: { sql: 'SELECT id FROM properties ORDER BY id LIMIT 2' } }])
    .respondWithTools(
      ids.map((id) => ({ name: 'task', args: { subagent_type: 'score-property', description: `Score ${id} for wheelchair access` } })),
    )
    .respondWithTools([{ name: 'place_object', args: { propertyId: ids[0], object: 'scissor lift' } }])
    .respond(new AIMessage('done'))

  const scorer = fakeModel()
  for (let i = 0; i < 4; i++) {
    scorer.respond((messages: BaseMessage[]) => {
      const ask = String(messages.find((m) => m.type === 'human')?.content)
      const propertyId = ids.find((id) => ask.includes(id)) ?? 'unknown'
      if (!messages.some((m) => ToolMessage.isInstance(m))) {
        return new AIMessage({ content: '', tool_calls: [{ name: 'get_property', args: { propertyId }, id: `get-${propertyId}` }] })
      }
      const score = { propertyId, score: 72, summary: 'Level entry likely.', evidence: [{ source: 'costar', detail: 'One storey.' }] }
      return new AIMessage({ content: '', tool_calls: [{ name: 'PropertyScore', args: score, id: `score-${propertyId}` }] })
    })
  }

  const agent = createProppy({ model: coordinator, subagentModel: scorer, checkpointer: new MemorySaver() })
  const config = { configurable: { thread_id: 'e2e' } }
  const pins: PinEvent[] = []
  let interrupted: unknown
  const stream = await agent.stream(
    { messages: [{ role: 'user', content: 'which are wheelchair-friendly?' }] },
    { ...config, streamMode: ['custom', 'updates'], subgraphs: true },
  )
  for await (const [, mode, chunk] of stream) {
    if (mode === 'custom') pins.push(chunk as PinEvent)
    if (mode === 'updates' && '__interrupt__' in chunk) interrupted = chunk.__interrupt__
  }

  for (const id of ids) {
    assert.ok(pins.some((p) => p.propertyId === id && p.status === 'scoring'), `${id} turned scoring`)
    assert.ok(pins.some((p) => p.propertyId === id && p.status === 'scored' && p.score === 72), `${id} turned scored`)
  }

  const { values } = await agent.graph.getState(config)
  const scores = toolMessages(values.messages, 'task').map((m) => PropertyScore.parse(JSON.parse(m.text)))
  assert.deepEqual(scores.map((s) => s.propertyId).sort(), [...ids].sort())

  assert.match(JSON.stringify(interrupted), /"name":"place_object"/)
  assert.equal(toolMessages(values.messages, 'place_object').length, 0, 'nothing placed before approval')

  const resumed = await agent.invoke(new Command({ resume: { decisions: [{ type: 'approve' }] } }), config)
  assert.match(toolMessages(resumed.messages, 'place_object')[0].text, /"requested":true/)
  assert.equal(resumed.messages.at(-1)?.text, 'done')
})

const scoreOne = async (propertyId: string, scorerTurns: ((messages: BaseMessage[]) => AIMessage)[]) => {
  const coordinator = fakeModel()
    .respondWithTools([{ name: 'task', args: { subagent_type: 'score-property', description: `Score ${propertyId}` } }])
    .respond(new AIMessage('done'))
  const scorer = fakeModel()
  for (const turn of scorerTurns) scorer.respond(turn)
  const agent = createProppy({ model: coordinator, subagentModel: scorer, checkpointer: new MemorySaver() })
  const pins: PinEvent[] = []
  const messages: BaseMessage[] = []
  const stream = await agent.stream(
    { messages: [{ role: 'user', content: 'which are wheelchair-friendly?' }] },
    { configurable: { thread_id: propertyId }, streamMode: ['custom', 'values'], subgraphs: true },
  )
  try {
    for await (const [namespace, mode, chunk] of stream) {
      if (mode === 'custom') pins.push(chunk as PinEvent)
      if (mode === 'values' && namespace.length === 0) messages.splice(0, messages.length, ...chunk.messages)
    }
    return { pins, messages, error: undefined }
  } catch (error) {
    return { pins, messages, error }
  }
}

const call = (name: string, args: Record<string, unknown>) => () =>
  new AIMessage({ content: '', tool_calls: [{ name, args, id: `${name}-call` }] })

test('a missing record and aerial still yield a PropertyScore', async () => {
  const propertyId = 'nope-1'
  const score = { propertyId, score: 10, summary: 'No record or aerial.', evidence: [] }
  const { pins, messages, error } = await scoreOne(propertyId, [
    call('get_property', { propertyId }),
    call('view_aerial', { propertyId }),
    call('PropertyScore', score),
  ])
  assert.equal(error, undefined)
  assert.deepEqual(PropertyScore.parse(JSON.parse(toolMessages(messages, 'task')[0].text)), score)
  assert.deepEqual(pins, [
    { type: 'pin', propertyId, status: 'scoring' },
    { type: 'pin', propertyId, status: 'scored', score: 10 },
  ])
})

test('a scorer that errors turns its pin failed', async () => {
  const propertyId = 'nope-2'
  const { pins, error } = await scoreOne(propertyId, [
    call('get_property', { propertyId }),
    () => {
      throw new Error('model overloaded')
    },
  ])
  assert.match(String(error), /model overloaded/)
  assert.deepEqual(pins.at(-1), { type: 'pin', propertyId, status: 'failed' })
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages'
import { mascotMood } from './mood.ts'

const ask = new HumanMessage('Which of these are wheelchair-friendly?')
const calling = (name: string) => new AIMessage({ content: '', tool_calls: [{ name, args: {}, id: `${name}-1` }] })

test('Proppy rests when no run streams, whatever the thread holds', () => {
  assert.equal(mascotMood([ask, calling('property_query')], false, false), 'idle')
})

test('a look-up, a running subagent or a run with no reply yet reads as analyzing', () => {
  assert.equal(mascotMood([ask], true, false), 'analyzing')
  assert.equal(mascotMood([ask, calling('property_query')], true, false), 'analyzing')
  assert.equal(mascotMood([ask, calling('view_aerial'), new ToolMessage({ content: '{}', tool_call_id: 'view_aerial-1' })], true, false), 'analyzing')
  assert.equal(mascotMood([ask, new AIMessage('Here is what I found')], true, true), 'analyzing')
})

test('writing the answer or calling a write op reads as working', () => {
  assert.equal(mascotMood([ask, new AIMessage('Three of them have')], true, false), 'working')
  assert.equal(mascotMood([ask, calling('signage_place')], true, false), 'working')
  assert.equal(mascotMood([ask, calling('write_todos')], true, false), 'working')
})

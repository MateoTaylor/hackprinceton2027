import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FRAMES, frameOf, isResting, REST, spritePosition, step, type Mood, type State } from './sequence.ts'

// Steps `n` frames under one mood and returns the frames shown after each step.
function play(state: State, mood: Mood, n: number) {
  const frames: string[] = []
  for (let i = 0; i < n; i++) {
    state = step(state, mood)
    frames.push(frameOf(state))
  }
  return { state, frames }
}

test('working plays the intro, loops, then the outro back to the hero', () => {
  const intro = play(REST, 'working', 12)
  assert.deepEqual(intro.frames, ['T1', 'T2', 'T3', 'T4', 'W1', 'W2', '4b', 'W4', 'W5', 'W6', 'W7', 'W8'])
  const outro = play(intro.state, 'idle', 16)
  assert.deepEqual(outro.frames, ['W4', '4b', 'W2', 'W9', 'W9', 'W9', 'W9', 'W1', 'T4', 'T3', 'T2', 'T1', 'hero', 'hero', 'hero', 'hero'])
  assert.ok(isResting(outro.state, 'idle'))
})

test('analyzing loops A7, A8, A6, A5 and finishes with the found-it and happy beats', () => {
  const run = play(REST, 'analyzing', 16)
  assert.deepEqual(run.frames.slice(8), ['A7', 'A8', 'A6', 'A5', 'A7', 'A8', 'A6', 'A5'])
  assert.deepEqual(play(run.state, 'idle', 13).frames, ['A9', 'A3', 'A2', 'W9', 'W9', 'W9', 'W9', 'A1', 'T4', 'T3', 'T2', 'T1', 'hero'])
})

test('a mood change mid-intro rewinds the intro instead of jumping', () => {
  const half = play(REST, 'working', 6) // at W2
  assert.deepEqual(play(half.state, 'idle', 7).frames, ['W1', 'T4', 'T3', 'T2', 'T1', 'hero', 'hero'])
  // Asking again mid-rewind resumes from where it is.
  const back = play(half.state, 'idle', 2) // at T4
  assert.deepEqual(play(back.state, 'working', 3).frames, ['W1', 'W2', '4b'])
})

test('switching tools finishes the outro before the other intro starts', () => {
  const working = play(REST, 'working', 10)
  const { frames } = play(working.state, 'analyzing', 14)
  assert.deepEqual(frames, ['W4', '4b', 'W2', 'W9', 'W9', 'W9', 'W9', 'W1', 'T4', 'T3', 'T2', 'T1', 'hero', 'T1'])
})

test('the outro cannot be interrupted', () => {
  const looping = play(REST, 'analyzing', 9)
  const outro = play(looping.state, 'idle', 2) // A9, A3
  assert.deepEqual(play(outro.state, 'analyzing', 2).frames, ['A2', 'W9'])
})

test('sprite positions address a 6-column sheet', () => {
  assert.equal(spritePosition('hero'), '0% 0%')
  assert.equal(spritePosition('W1'), '100% 0%')
  assert.equal(spritePosition(FRAMES.at(-1)!), '80% 100%')
})

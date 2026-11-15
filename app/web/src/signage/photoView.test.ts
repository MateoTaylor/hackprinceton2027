import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fitted, panned, turnRest, turnStep, viewBoxOf, zoomedAbout } from './photoView.ts'

const frame = { x: 100, y: 50, w: 800, h: 600 }

test('zooming about a point keeps that point under the pointer', () => {
  const zoom = zoomedAbout(frame, fitted(frame), 2, [300, 200])
  const box = viewBoxOf(frame, zoom)
  assert.equal(zoom.scale, 2)
  // The point sat a quarter of the way across the fitted frame, and still does.
  assert.equal((300 - box.x) / box.w, (300 - frame.x) / frame.w)
  assert.equal((200 - box.y) / box.h, (200 - frame.y) / frame.h)
})

test('the view never leaves the frame or zooms out past it', () => {
  assert.equal(zoomedAbout(frame, fitted(frame), 0.5, [300, 200]).scale, 1)
  const box = viewBoxOf(frame, panned(frame, { scale: 4, cx: 500, cy: 350 }, -5000, 5000))
  assert.deepEqual(box, { x: 100, y: 500, w: 200, h: 150 })
})

test('a turn rests on the nearest photo and a small one springs back', () => {
  const all = ['north', 'east', 'south', 'west'] as const
  assert.equal(turnRest(all, 'north', 30), 'north')
  assert.equal(turnRest(all, 'north', 60), 'east')
  assert.equal(turnRest(all, 'north', -60), 'west')
  assert.equal(turnRest(['north', 'south'], 'north', 60), 'north')
})

test('the arrow keys step to the next photo either way and skip missing ones', () => {
  assert.equal(turnStep(['north', 'east', 'south', 'west'], 'west', 1), 'north')
  assert.equal(turnStep(['north', 'south', 'west'], 'north', 1), 'south')
  assert.equal(turnStep(['north', 'south', 'west'], 'north', -1), 'west')
  assert.equal(turnStep(['north'], 'north', 1), 'north')
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Vector3 } from 'three'
import type { Ring } from '../../../server/src/model/building.ts'
import { FIXTURES } from '../../../server/src/model/fixtures.ts'
import { DEFAULT_LOOK } from './looks.ts'
import { focusBox, occluders } from './view.ts'

const { officeTower } = FIXTURES
const rect = (x0: number, y0: number, x1: number, y1: number): Ring => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]

test('the whole building frames its shell and none of its neighbours', () => {
  const box = focusBox(officeTower, null)
  assert.deepEqual([box.min.x, box.max.x, box.min.y, box.max.y], [-28, 28, 0, officeTower.shell.heightM])
})

test('a scanned storey centres on its scanned space and stays inside its floor plate', () => {
  const storey = officeTower.storeys.find(({ spaces }) => spaces.some(({ source }) => source === 'scan'))
  assert.ok(storey)
  const box = focusBox(officeTower, storey.index)
  const floor = focusBox({ ...officeTower, storeys: [{ ...storey, spaces: [] }] }, storey.index)
  const scan = focusBox({ ...officeTower, storeys: [{ ...storey, spaces: storey.spaces.filter(({ source }) => source === 'scan') }] }, storey.index)
  const centre = box.getCenter(new Vector3())
  assert.ok(centre.distanceTo(scan.getCenter(new Vector3())) < 1e-9)
  assert.ok(floor.containsBox(box))
})

test('a small scanned room near a wall opens on that room with floor around it, clamped to the plate', () => {
  const storey = officeTower.storeys.find(({ spaces }) => spaces.some(({ source }) => source === 'scan'))
  const space = storey?.spaces.find(({ source }) => source === 'scan')
  assert.ok(storey && space)
  const building = { ...officeTower, storeys: [{ ...storey, spaces: [{ ...space, ring: rect(14, 6, 18, 10) }] }] }
  const box = focusBox(building, storey.index)
  // The 4 m room grows to the 6 m minimum half-width, and the plate's east edge at x = 20 clips it.
  assert.deepEqual([box.min.x, box.max.x], [10, 20])
})

test('a tall neighbour on the camera side is an occluder and one behind is not', () => {
  // DEFAULT_LOOK looks north-east, so the camera stands to the south-west.
  const building = { ...officeTower, context: [{ ring: rect(-70, -70, -45, -45), heightM: 120 }, { ring: rect(45, 45, 70, 70), heightM: 120 }] }
  assert.deepEqual([...occluders(building, null, DEFAULT_LOOK)], [0])
  assert.deepEqual([...occluders(building, 3, DEFAULT_LOOK)], [0])
})

test('a low neighbour off to the side hides nothing', () => {
  const building = { ...officeTower, context: [{ ring: rect(-140, 100, -120, 120), heightM: 6 }] }
  assert.equal(occluders(building, null, DEFAULT_LOOK).size, 0)
})

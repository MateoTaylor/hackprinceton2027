import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { BuildingModel, Ring } from '../../model/building.ts'
import { ringArea } from '../../model/geo.ts'
import { stackStoreys, STOREY_HEIGHT_DEFAULT_M } from './storeys.ts'

const rect = (x0: number, y0: number, x1: number, y1: number): Ring => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
const volume = (id: string, ring: Ring, topM: number, primary: boolean): BuildingModel['shell']['volumes'][number] => ({ id, ring, baseM: 0, topM, primary, source: 'vexcel', confidence: 0.9 })
const commercial = { kind: 'commercial' as const }

test('CoStar storeys and slab height give the stack', () => {
  const shell = { heightM: 45, volumes: [volume('v', rect(0, 0, 30, 20), 45, true)] }
  const { storeys, assumptions } = stackStoreys(shell, { stories: 12, slabToSlabFt: 12, floors: [] }, commercial)
  assert.equal(storeys.length, 12)
  assert.ok(Math.abs(storeys[0].heightM - 3.6576) < 1e-6)
  assert.ok(Math.abs(storeys[11].elevationM - 11 * 3.6576) < 1e-6)
  assert.deepEqual(storeys.map(({ label }) => label).slice(0, 2), ['Floor 1', 'Floor 2'])
  assert.equal(storeys[0].source, 'costar')
  assert.equal(assumptions.length, 0)
})

test('without CoStar facts the shell height sets the count', () => {
  const shell = { heightM: 11, volumes: [volume('v', rect(0, 0, 10, 10), 11, true)] }
  const { storeys, assumptions } = stackStoreys(shell, undefined, commercial)
  assert.equal(storeys.length, Math.floor(11 / STOREY_HEIGHT_DEFAULT_M.commercial))
  assert.equal(storeys[0].source, 'inferred')
  assert.equal(assumptions.length, 2)
})

test('a stack too tall for the shell is squeezed into it', () => {
  const shell = { heightM: 20, volumes: [volume('v', rect(0, 0, 10, 10), 20, true)] }
  const { storeys } = stackStoreys(shell, { stories: 10, slabToSlabFt: 12, floors: [] }, commercial)
  assert.ok(Math.abs(storeys[0].heightM - 2) < 1e-9)
})

test('a podium widens the low storeys and a separate low building is left out', () => {
  const tower = volume('tower', rect(0, 0, 20, 20), 40, false)
  const podium = volume('podium', rect(-10, -10, 30, 30), 8, false)
  const garage = volume('garage', rect(60, 0, 100, 40), 9, true)
  const { storeys } = stackStoreys({ heightM: 40, volumes: [garage, podium, tower] }, { stories: 10, slabToSlabFt: 13, floors: [] }, commercial)
  assert.equal(Math.round(ringArea(storeys[0].ring)), 1600)
  assert.equal(Math.round(ringArea(storeys[9].ring)), 400)
})

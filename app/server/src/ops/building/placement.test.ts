import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Ring, Storey } from '../../model/building.ts'
import { orientCcw } from '../../model/geo.ts'
import { applyTransform, placeScan, storeyFromName } from './placement.ts'
import type { ScanFloor, ScanPlan } from './scanPlan.ts'

const rect = (x0: number, y0: number, x1: number, y1: number): Ring => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
const L: Ring = orientCcw([[0, 0], [30, 0], [30, 10], [10, 10], [10, 25], [0, 25]])

const storeysOf = (ring: Ring, count = 1): Storey[] =>
  Array.from({ length: count }, (_, index) => ({
    index,
    label: `Floor ${index + 1}`,
    elevationM: index * 3.5,
    heightM: 3.5,
    ring,
    source: 'vexcel',
    confidence: 0.8,
    spaces: [],
    openings: [],
    furnishings: [],
  }))

const floorOf = (outline: Ring, sequence = 0): ScanFloor => ({
  id: `f${sequence}`,
  sequence,
  label: '',
  outline,
  spaces: [{ id: `room-${sequence}`, label: 'Office', ring: outline, areaM2: 0, ceilingM: null, stair: false }],
  openings: [],
})

const planOf = (...floors: ScanFloor[]): ScanPlan => ({ modelId: 'scan', floors, skippedRooms: 0 })

test('an outline fit recovers a known transform', () => {
  const known = { tx: 12, ty: -7, yawDeg: 30 }
  const ring = L.map((point) => applyTransform(point, known))
  const placement = placeScan(planOf(floorOf(L)), { modelId: 'scan', name: 'Whole floor' }, storeysOf(ring), new Map())
  assert.equal(placement.kind, 'placed')
  if (placement.kind !== 'placed') return
  const { scan } = placement
  assert.equal(scan.fit, 'outline')
  assert.ok(Math.abs(scan.transform.yawDeg - 30) < 1)
  assert.ok(Math.abs(scan.transform.tx - 12) < 0.1 && Math.abs(scan.transform.ty + 7) < 0.1)
  assert.equal(scan.flipAmbiguous, false)
  assert.ok(scan.iou !== null && scan.iou > 0.99)
})

test('a rectangle fits turned either way, so its flip is ambiguous', () => {
  const placement = placeScan(planOf(floorOf(rect(0, 0, 30, 12))), { modelId: 'scan', name: 'Floor' }, storeysOf(rect(100, 50, 130, 62)), new Map())
  assert.equal(placement.kind === 'placed' && placement.scan.flipAmbiguous, true)
})

test('a small suite is centred on the storey its number names', () => {
  const placement = placeScan(planOf(floorOf(rect(0, 0, 8, 5))), { modelId: 'scan', name: 'Suite 300' }, storeysOf(rect(0, 0, 40, 24), 5), new Map())
  assert.equal(placement.kind, 'placed')
  if (placement.kind !== 'placed') return
  assert.equal(placement.scan.fit, 'inferred')
  assert.equal(placement.scan.iou, null)
  assert.deepEqual(placement.scan.storeyIndexes, [2])
  assert.equal(placement.spaces.get(2)?.length, 1)
})

test('a scan bigger than every storey is not placed', () => {
  const placement = placeScan(planOf(floorOf(rect(0, 0, 80, 6))), { modelId: 'scan', name: 'Floor' }, storeysOf(rect(0, 0, 20, 20)), new Map())
  assert.equal(placement.kind, 'unplaced')
})

test('a scan on top of one placed before is not placed', () => {
  const taken = new Map([[0, [rect(0, 0, 40, 24)]]])
  const placement = placeScan(planOf(floorOf(rect(0, 0, 40, 24))), { modelId: 'scan', name: 'Floor' }, storeysOf(rect(0, 0, 40, 24)), taken)
  assert.equal(placement.kind, 'unplaced')
})

test('a street number in a scan name is not read as a suite', () => {
  assert.equal(storeyFromName('1200 Main St lobby', 20, '1200 Main St').index, 0)
  assert.equal(storeyFromName('1200 Main St, 0450', 20, '1200 Main St').index, 3)
  assert.equal(storeyFromName('Suite 1200', 20, '1200 Main St').index, 11)
})

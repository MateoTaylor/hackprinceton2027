import assert from 'node:assert/strict'
import { test } from 'node:test'
import { maskFrame, quadMatrix, viewRay } from './renderAnchor.ts'

const close = (actual: number[], expected: number[]) => actual.forEach((v, i) => assert.ok(Math.abs(v - expected[i]) < 1e-9, `${actual} ≉ ${expected}`))

test('a view’s centre looks along its yaw and pitch, and its right edge is half the fov to the right', () => {
  const view = { yaw: 90, pitch: 0, fov: 90, width: 100, height: 100 }
  close(viewRay(view, 50, 50), [0, 1, 0])
  // Yaw turns from +X towards +Y, so facing +Y the right hand points along +X.
  close(viewRay(view, 100, 50), [Math.SQRT1_2, Math.SQRT1_2, 0])
  close(viewRay(view, 50, 0), [0, Math.SQRT1_2, Math.SQRT1_2])
})

test('the quad matrix sends the box corners to the quad corners', () => {
  const quad: [number, number][] = [[10, 20], [200, 5], [230, 160], [0, 140]]
  const m = quadMatrix(40, 30, quad).slice(9, -1).split(',').map(Number)
  const map = (x: number, y: number) => {
    const w = m[3] * x + m[7] * y + m[15]
    return [(m[0] * x + m[4] * y + m[12]) / w, (m[1] * x + m[5] * y + m[13]) / w]
  }
  close(map(0, 0), quad[0])
  close(map(40, 0), quad[1])
  close(map(40, 30), quad[2])
  close(map(0, 30), quad[3])
})

test('the mask frame grows around the white pixels and stays inside the picture', () => {
  const width = 10
  const data = new Array(width * width * 4).fill(0)
  for (const [x, y] of [[2, 3], [4, 5]]) data[(y * width + x) * 4] = 255
  assert.deepEqual(maskFrame({ data, width, height: width }, 0.5, 1), { x0: 1, y0: 2, x1: 6, y1: 7 })
  assert.deepEqual(maskFrame({ data, width, height: width }, 0, 8), { x0: 0, y0: 0, x1: 10, y1: 10 })
  assert.equal(maskFrame({ data: new Array(16).fill(0), width: 2, height: 2 }), null)
})

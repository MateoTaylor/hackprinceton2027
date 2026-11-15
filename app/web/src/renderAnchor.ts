import type { RenderSlide } from '../../shared/api'

export type Vec3 = [number, number, number]
export type Point = [number, number]
export type Rect = { x0: number; y0: number; x1: number; y1: number }

const rad = (deg: number) => (deg * Math.PI) / 180
const norm = ([x, y, z]: Vec3): Vec3 => {
  const l = Math.hypot(x, y, z)
  return [x / l, y / l, z / l]
}
const cross = ([ax, ay, az]: Vec3, [bx, by, bz]: Vec3): Vec3 => [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx]

// The Z-up world direction pixel (px, py) of a slide's view looks along. Mirrors Camera in
// tools/qwen_test/pano.py, the pinhole camera Mateo's pipeline renders its flat views with:
// forward from yaw and pitch, right = forward × Z, up = right × forward.
export function viewRay({ yaw, pitch, fov, width, height }: RenderSlide['view'], px: number, py: number): Vec3 {
  const f: Vec3 = [Math.cos(rad(yaw)) * Math.cos(rad(pitch)), Math.sin(rad(yaw)) * Math.cos(rad(pitch)), Math.sin(rad(pitch))]
  const r = norm(cross(f, [0, 0, 1]))
  const u = cross(r, f)
  const focal = width / 2 / Math.tan(rad(fov) / 2)
  const a = (px - width / 2) / focal
  const b = (py - height / 2) / focal
  return norm([f[0] + a * r[0] - b * u[0], f[1] + a * r[1] - b * u[1], f[2] + a * r[2] - b * u[2]])
}

// The scan's Z-up world frame in the viewer's Y-up three.js frame.
export const toThree = ([x, y, z]: Vec3): Vec3 => [x, z, -y]

// A CSS matrix3d (with transform-origin 0 0) that maps a w × h box onto the quad `to`, given
// top-left, top-right, bottom-right, bottom-left. Two pinhole pictures taken from one point differ
// by exactly such a projective map, so a crop of the view lands on the live view without drift.
export function quadMatrix(w: number, h: number, [[x0, y0], [x1, y1], [x2, y2], [x3, y3]]: Point[]) {
  const dx1 = x1 - x2
  const dx2 = x3 - x2
  const dx3 = x0 - x1 + x2 - x3
  const dy1 = y1 - y2
  const dy2 = y3 - y2
  const dy3 = y0 - y1 + y2 - y3
  const det = dx1 * dy2 - dx2 * dy1
  const g = (dx3 * dy2 - dx2 * dy3) / det
  const k = (dx1 * dy3 - dx3 * dy1) / det
  const a = x1 - x0 + g * x1
  const b = x3 - x0 + k * x3
  const d = y1 - y0 + g * y1
  const e = y3 - y0 + k * y3
  return `matrix3d(${[a / w, d / w, 0, g / w, b / h, e / h, 0, k / h, 0, 0, 1, 0, x0, y0, 0, 1].join(',')})`
}

// The box around the white pixels of a mask, grown by `pad` of its longer side (at least `min`
// pixels) so the frame takes in the object around the change, and kept inside the picture.
// Null when nothing is white.
export function maskFrame({ data, width, height }: { data: ArrayLike<number>; width: number; height: number }, pad = 0.15, min = 24): Rect | null {
  let x0 = width
  let y0 = height
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4] < 128) continue
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }
  if (x1 < 0) return null
  const grow = Math.max(min, pad * Math.max(x1 - x0, y1 - y0))
  return { x0: Math.max(0, x0 - grow), y0: Math.max(0, y0 - grow), x1: Math.min(width, x1 + 1 + grow), y1: Math.min(height, y1 + 1 + grow) }
}

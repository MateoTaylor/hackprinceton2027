import { BoxGeometry, BufferGeometry, Group, Mesh, ShapeGeometry } from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { Opening, Point, Ring, Storey } from '../../../server/src/model/building.ts'
import { flatMaterial, protoTone, styleFor } from './inferredStyle.ts'
import type { Look } from './looks.ts'
import { MODEL_TO_SCENE, shapeOf } from './massing.ts'
import { protoMaterial } from './protoGrid.ts'

// A straight run of wall from `a` to `b` in the building frame.
export type WallSegment = { a: Point; b: Point }

const ON_EDGE_M = 0.05
const ROUND_M = 0.01
const MIN_SEGMENT_M = 0.02
const WALL_THICKNESS_M = 0.15
const SLAB_LIFT_M = 0.02
const SILL_M = 0.02
const CAP_LIFT_M = 0.002

const round = (value: number) => Math.round(value / ROUND_M) / (1 / ROUND_M) + 0
const roundPoint = ([x, y]: Point): Point => [round(x), round(y)]

// The walls along a ring, with a gap of each opening's width centred on its `at` for every
// opening that lies within 0.05 m of an edge. Ends are rounded to 0.01 m, so the shared wall of
// two spaces gives the same segment from both rings.
//   wallSegments(space.ring, storey.openings)
export function wallSegments(ring: Ring, openings: Pick<Opening, 'at' | 'widthM'>[]): WallSegment[] {
  return ring.flatMap((a, i) => {
    const b = ring[(i + 1) % ring.length]
    const [dx, dy] = [b[0] - a[0], b[1] - a[1]]
    const length = Math.hypot(dx, dy)
    if (length < MIN_SEGMENT_M) return []
    const gaps = openings
      .flatMap(({ at, widthM }) => {
        const t = ((at[0] - a[0]) * dx + (at[1] - a[1]) * dy) / length
        const off = Math.abs((at[0] - a[0]) * dy - (at[1] - a[1]) * dx) / length
        return off <= ON_EDGE_M && t >= -widthM / 2 && t <= length + widthM / 2 ? [[t - widthM / 2, t + widthM / 2]] : []
      })
      .toSorted(([s], [t]) => s - t)
    const runs: [number, number][] = []
    let from = 0
    for (const [start, end] of gaps) {
      if (start > from) runs.push([from, Math.min(start, length)])
      from = Math.max(from, end)
    }
    if (from < length) runs.push([from, length])
    const at = (t: number): Point => roundPoint([a[0] + (dx * t) / length, a[1] + (dy * t) / length])
    return runs.filter(([s, e]) => e - s >= MIN_SEGMENT_M).map(([s, e]) => ({ a: at(s), b: at(e) }))
  })
}

const segmentKey = ({ a, b }: WallSegment) => [a.join(','), b.join(',')].toSorted().join('|')

// A box `lengthM` long along the segment, standing on `baseM`, in scene coordinates.
function boxAlong({ a, b }: WallSegment, widthM: number, heightM: number, baseM: number) {
  const length = Math.hypot(b[0] - a[0], b[1] - a[1])
  const box = new BoxGeometry(length, widthM, heightM)
  box.rotateZ(Math.atan2(b[1] - a[1], b[0] - a[0]))
  box.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, baseM + heightM / 2)
  return box.applyMatrix4(MODEL_TO_SCENE)
}

const mergedMesh = (geometries: BufferGeometry[], material: Mesh['material']) => {
  const merged = mergeGeometries(geometries)
  for (const geometry of geometries) geometry.dispose()
  const mesh = new Mesh(merged, material)
  mesh.castShadow = mesh.receiveShadow = true
  return mesh
}

// One storey opened to view: a slab per space in its style, the storey ring under them, wall
// stubs `look.wallStubM` tall with a dark cap, and a sill across each opening. Each slab carries
// `userData.spaceId` and every mesh `userData.storeyIndex`, so a pick can name what it hit.
export function buildStorey(storey: Storey, look: Look) {
  const group = new Group()
  group.name = `storey-${storey.index}`
  const lift = (geometry: BufferGeometry, by: number) => geometry.applyMatrix4(MODEL_TO_SCENE).translate(0, storey.elevationM + by, 0)

  const storeyTone = protoTone(storey.confidence)
  const base = new Mesh(lift(new ShapeGeometry(shapeOf(storey.ring)), 0), protoMaterial(storeyTone, look))
  base.receiveShadow = true
  base.userData = { storeyIndex: storey.index, spaceId: null }
  group.add(base)

  const walls = new Map<string, { segment: WallSegment; color: string }>()
  const addWalls = (ring: Ring, color: string) => {
    for (const segment of wallSegments(ring, storey.openings)) {
      const key = segmentKey(segment)
      if (!walls.has(key)) walls.set(key, { segment, color })
    }
  }
  const spaces = storey.spaces.toSorted((a, b) => Number(b.source === 'scan') - Number(a.source === 'scan'))
  for (const space of spaces) {
    const style = styleFor(space, look)
    const slab = new Mesh(lift(new ShapeGeometry(shapeOf(space.ring)), SLAB_LIFT_M), style.floor)
    slab.receiveShadow = true
    slab.name = space.id
    slab.userData = { storeyIndex: storey.index, spaceId: space.id }
    group.add(slab)
    addWalls(space.ring, style.wallColor)
  }
  addWalls(storey.ring, look.palette.proto[storeyTone].line)

  const byColor = new Map<string, WallSegment[]>()
  for (const { segment, color } of walls.values()) byColor.set(color, [...(byColor.get(color) ?? []), segment])
  const caps: BufferGeometry[] = []
  for (const [color, entries] of byColor) {
    const sides = entries.map((segment) => boxAlong(segment, WALL_THICKNESS_M, look.wallStubM, storey.elevationM))
    caps.push(...entries.map((segment) => boxAlong(segment, WALL_THICKNESS_M, CAP_LIFT_M, storey.elevationM + look.wallStubM)))
    group.add(mergedMesh(sides, flatMaterial(color, look)))
  }
  if (caps.length) group.add(mergedMesh(caps, flatMaterial(look.palette.cut, look)))

  const sills = storey.openings.map(({ at, widthM, bearingDeg }) => {
    // The wall runs at right angles to the bearing, which is the compass direction through it.
    const bearing = (bearingDeg * Math.PI) / 180
    const half: Point = [(Math.cos(bearing) * widthM) / 2, (-Math.sin(bearing) * widthM) / 2]
    return boxAlong({ a: [at[0] - half[0], at[1] - half[1]], b: [at[0] + half[0], at[1] + half[1]] }, WALL_THICKNESS_M, SILL_M, storey.elevationM)
  })
  if (sills.length) group.add(mergedMesh(sills, flatMaterial(look.palette.cut, look)))
  return group
}

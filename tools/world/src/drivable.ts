/**
 * A top-down map of where a scan has floor, baked once by ray casting.
 *
 * Scans have unscanned regions and gaps in their walls. The simulation uses this map
 * to wall those off, so nothing drives into a place the scanner never saw.
 *
 *   const bvh = buildBvh(mesh)
 *   const map = bakeDrivable(mesh, bvh, 0.25)
 *   map.cells[row * map.cols + col] === Cell.clear
 */
import { BufferAttribute, BufferGeometry, DoubleSide, Ray, Vector3 } from 'three'
import { MeshBVH } from 'three-mesh-bvh'
import type { CollisionMesh } from './collision-mesh.ts'

export const Cell = { clear: 0, blocked: 1, hole: 2, outside: 3 } as const

export type Drivable = {
  floorHeight: number
  cell: number
  cols: number
  rows: number
  originX: number
  originZ: number
  /** Row-major `Cell` values. Rows run along +z, columns along +x. */
  cells: Uint8Array
  /** Height of the first surface under each cell's probe, or NaN where there is none. */
  surface: Float32Array
}

const HEADROOM = 2.0
const STEP = 0.15

export function buildBvh(mesh: CollisionMesh) {
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(mesh.positions, 3))
  geometry.setIndex(new BufferAttribute(mesh.indices, 1))
  return new MeshBVH(geometry, { indirect: true })
}

/** The height that holds the most level surface area, which is the main floor. */
export function findFloorHeight(mesh: CollisionMesh) {
  const bins = new Map<number, number>()
  const { positions: p, indices } = mesh
  const a = new Vector3()
  const b = new Vector3()
  const c = new Vector3()
  const edge = new Vector3()
  const normal = new Vector3()
  for (let i = 0; i < indices.length; i += 3) {
    a.fromArray(p, indices[i] * 3)
    b.fromArray(p, indices[i + 1] * 3)
    c.fromArray(p, indices[i + 2] * 3)
    normal.subVectors(b, a).cross(edge.subVectors(c, a))
    const doubleArea = normal.length()
    if (doubleArea === 0 || Math.abs(normal.y) / doubleArea < 0.95) continue
    const bin = Math.round(((a.y + b.y + c.y) / 3) * 20)
    bins.set(bin, (bins.get(bin) ?? 0) + doubleArea / 2)
  }
  const ranked = [...bins].sort((x, y) => y[1] - x[1])
  return {
    height: ranked[0][0] / 20,
    top: ranked.slice(0, 5).map(([bin, area]) => `${(bin / 20).toFixed(2)} m: ${area.toFixed(0)} m2`),
  }
}

export function bakeDrivable(mesh: CollisionMesh, bvh: MeshBVH, cell: number): Drivable {
  const floorHeight = findFloorHeight(mesh).height
  const cols = Math.ceil((mesh.max.x - mesh.min.x) / cell)
  const rows = Math.ceil((mesh.max.z - mesh.min.z) / cell)
  const cells = new Uint8Array(cols * rows)
  const surface = new Float32Array(cols * rows).fill(NaN)
  const probeY = floorHeight + HEADROOM
  const ray = new Ray()

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      ray.origin.set(mesh.min.x + (col + 0.5) * cell, probeY, mesh.min.z + (row + 0.5) * cell)
      ray.direction.set(0, -1, 0)
      const below = bvh.raycastFirst(ray, DoubleSide)
      const i = row * cols + col
      if (below) surface[i] = probeY - below.distance

      if (below && Math.abs(surface[i] - floorHeight) <= STEP) {
        cells[i] = Cell.clear
      } else if (below && surface[i] > floorHeight + STEP) {
        cells[i] = Cell.blocked
      } else {
        ray.direction.set(0, 1, 0)
        cells[i] = bvh.raycastFirst(ray, DoubleSide) ? Cell.hole : Cell.outside
      }
    }
  }

  return { floorHeight, cell, cols, rows, originX: mesh.min.x, originZ: mesh.min.z, cells, surface }
}

const NEIGHBORS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const

/**
 * The parts of the map to wall off, as runs of cells along a row. A region without
 * floor is walled off when it reaches the map edge or covers at least `minArea`
 * square meters. Smaller gaps are scan noise and stay open.
 */
export function voidRuns(map: Drivable, minArea: number) {
  const { cols, rows, cells, cell } = map
  const isVoid = (i: number) => cells[i] === Cell.hole || cells[i] === Cell.outside
  const walled = new Uint8Array(cols * rows)
  const seen = new Uint8Array(cols * rows)

  for (let start = 0; start < cells.length; start++) {
    if (seen[start] || !isVoid(start)) continue
    const region = [start]
    seen[start] = 1
    let reachesEdge = false
    for (let n = 0; n < region.length; n++) {
      const col = region[n] % cols
      const row = (region[n] - col) / cols
      if (col === 0 || row === 0 || col === cols - 1 || row === rows - 1) reachesEdge = true
      for (const [dc, dr] of NEIGHBORS) {
        const c = col + dc
        const r = row + dr
        if (c < 0 || r < 0 || c >= cols || r >= rows) continue
        const next = r * cols + c
        if (seen[next] || !isVoid(next)) continue
        seen[next] = 1
        region.push(next)
      }
    }
    if (reachesEdge || region.length * cell * cell >= minArea) for (const i of region) walled[i] = 1
  }

  const runs: { row: number; from: number; to: number }[] = []
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      if (!walled[row * cols + col]) continue
      const from = col
      while (col + 1 < cols && walled[row * cols + col + 1]) col++
      runs.push({ row, from, to: col })
    }
  }
  return runs
}

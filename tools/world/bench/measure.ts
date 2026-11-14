/**
 * Measures a downloaded scan's meshes as a drivable world and prints a floor map.
 *
 *   node bench/measure.ts <scan dir> [cell meters]
 *
 * For each mesh in the manifest it reports size, bounds and the floor height, then
 * prints the baked floor map:
 *   .  clear floor with headroom      #  something stands on the floor
 *   o  no floor under a roof (hole)   (blank) outside the scan
 *   0-9, a-z  a panorama position, which is a spot a person stood on
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fromScan, parseObj } from '../src/collision-mesh.ts'
import { bakeDrivable, buildBvh, Cell, findFloorHeight } from '../src/drivable.ts'

const [scanDir, cellArg] = process.argv.slice(2)
if (!scanDir) throw new Error('usage: node bench/measure.ts <scan dir> [cell meters]')
const cell = Number(cellArg ?? 0.5)

type Manifest = {
  meshes: { path: string; bytes: number }[]
  locations: { label: string; position: [number, number, number] }[]
}
const manifest: Manifest = JSON.parse(readFileSync(join(scanDir, 'manifest.json'), 'utf8'))
const panos = manifest.locations.map((l) => fromScan(...l.position))

const MARKS = { [Cell.clear]: '.', [Cell.blocked]: '#', [Cell.hole]: 'o', [Cell.outside]: ' ' }

function report(path: string) {
  const mesh = parseObj(readFileSync(join(scanDir, path), 'utf8'))
  const built = performance.now()
  const bvh = buildBvh(mesh)
  const bvhMs = performance.now() - built
  const baked = performance.now()
  const map = bakeDrivable(mesh, bvh, cell)
  const bakeMs = performance.now() - baked

  const counts = { clear: 0, blocked: 0, hole: 0, outside: 0 }
  const names = ['clear', 'blocked', 'hole', 'outside'] as const
  const deviation: number[] = []
  const rows: string[] = []
  for (let row = 0; row < map.rows; row++) {
    let line = ''
    for (let col = 0; col < map.cols; col++) {
      const i = row * map.cols + col
      const kind = map.cells[i] as keyof typeof MARKS
      counts[names[kind]]++
      if (kind === Cell.clear) deviation.push(map.surface[i] - map.floorHeight)
      const cx = map.originX + (col + 0.5) * cell
      const cz = map.originZ + (row + 0.5) * cell
      const pano = panos.findIndex((q) => Math.abs(q.x - cx) <= cell / 2 && Math.abs(q.z - cz) <= cell / 2)
      line += pano >= 0 ? pano.toString(36) : MARKS[kind]
    }
    rows.push(line)
  }

  deviation.sort((x, y) => x - y)
  const at = (q: number) => deviation[Math.floor(q * (deviation.length - 1))]
  const size = (axis: 'x' | 'y' | 'z') => (mesh.max[axis] - mesh.min[axis]).toFixed(2)

  console.log(`\n=== ${path}`)
  console.log(`vertices ${mesh.positions.length / 3}, triangles ${mesh.indices.length / 3}, BVH build ${bvhMs.toFixed(0)} ms, bake ${bakeMs.toFixed(0)} ms`)
  console.log(`size x ${size('x')} y(up) ${size('y')} z ${size('z')} m`)
  console.log(`min ${JSON.stringify(mesh.min)} max ${JSON.stringify(mesh.max)}`)
  console.log(`floor height ${map.floorHeight.toFixed(2)} m. Largest level surfaces: ${findFloorHeight(mesh).top.join(' | ')}`)
  console.log(`floor roughness (m, p1/p50/p99 of clear cells vs floor height): ${at(0.01).toFixed(3)} / ${at(0.5).toFixed(3)} / ${at(0.99).toFixed(3)}`)
  console.log(`cells at ${cell} m: ${JSON.stringify(counts)}`)
  console.log(`map: +x right, +z down, origin cell x=${mesh.min.x.toFixed(2)} z=${mesh.min.z.toFixed(2)}`)
  for (const row of rows) console.log(row)
}

console.log(`panoramas (sim frame): ${panos.map((q, i) => `${i.toString(36)}=(${q.x.toFixed(1)}, ${q.y.toFixed(2)}, ${q.z.toFixed(1)})`).join(' ')}`)
for (const entry of manifest.meshes) report(entry.path)

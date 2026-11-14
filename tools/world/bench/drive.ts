/**
 * Drives the lift through a downloaded scan without a browser and prints what happened.
 *
 *   node bench/drive.ts <scan dir>
 *
 * Each motion model runs the same scripted moves: settle, drive straight, turn, reverse,
 * push a crate, raise the deck to the ceiling, and hold full throttle into the scan's
 * edge in four directions.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fromScan, parseObj } from '../src/collision-mesh.ts'
import { bakeDrivable, buildBvh } from '../src/drivable.ts'
import { createWorld, DT, VARIANTS, type LiftInput, type Variant } from '../src/world.ts'

const [scanDir] = process.argv.slice(2)
if (!scanDir) throw new Error('usage: node bench/drive.ts <scan dir>')

type Manifest = { meshes: { path: string }[]; locations: { position: [number, number, number] }[] }
const manifest: Manifest = JSON.parse(readFileSync(join(scanDir, 'manifest.json'), 'utf8'))
const collisionPath = manifest.meshes.find((m) => m.path.endsWith('out_res_50k.obj'))?.path
if (!collisionPath) throw new Error('the scan has no out_res_50k.obj collision mesh')

const mesh = parseObj(readFileSync(join(scanDir, collisionPath), 'utf8'))
const map = bakeDrivable(mesh, buildBvh(mesh), 0.25)
const mid = { x: (mesh.min.x + mesh.max.x) / 2, z: (mesh.min.z + mesh.max.z) / 2 }
const spawn = manifest.locations
  .map((l) => fromScan(...l.position))
  .sort((a, b) => Math.hypot(a.x - mid.x, a.z - mid.z) - Math.hypot(b.x - mid.x, b.z - mid.z))[0]

const world = await createWorld(mesh, map, spawn)
const IDLE: LiftInput = { throttle: 0, steer: 0, raise: 0 }
const deg = (radians: number) => ((radians * 180) / Math.PI).toFixed(1)
const f = (n: number) => n.toFixed(2)
const yawOf = (q: { x: number; y: number; z: number; w: number }) =>
  Math.atan2(-2 * (q.x * q.z - q.w * q.y), 1 - 2 * (q.y * q.y + q.z * q.z))

let stepMs = 0
let stepCount = 0

/** Runs `seconds` of one input and reports how the lift moved while it ran. */
function run(seconds: number, input: Partial<LiftInput>) {
  const start = world.lift()
  let minY = Infinity
  let maxY = -Infinity
  let tilt = 0
  let topSpeed = 0
  let turned = 0
  let lastYaw = yawOf(start.rotation)
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    const began = performance.now()
    world.step({ ...IDLE, ...input })
    stepMs += performance.now() - began
    stepCount++
    const { position, rotation, speed } = world.lift()
    const yaw = yawOf(rotation)
    turned += Math.atan2(Math.sin(yaw - lastYaw), Math.cos(yaw - lastYaw))
    lastYaw = yaw
    minY = Math.min(minY, position.y)
    maxY = Math.max(maxY, position.y)
    tilt = Math.max(tilt, Math.acos(Math.min(1, 1 - 2 * (rotation.x ** 2 + rotation.z ** 2))))
    topSpeed = Math.max(topSpeed, Math.abs(speed))
  }
  const end = world.lift()
  return {
    dx: end.position.x - start.position.x,
    dz: end.position.z - start.position.z,
    turned,
    bob: maxY - minY,
    y: end.position.y,
    tilt,
    topSpeed,
    end,
  }
}

function bench(variant: Variant) {
  console.log(`\n=== ${VARIANTS[variant]}`)
  world.setVariant(variant)
  const home = () => world.respawn(spawn.x, spawn.z, 0)

  home()
  const settle = run(2, {})
  console.log(`settle 2 s      y ${f(settle.y)} (floor ${f(map.floorHeight)}), drift ${f(Math.hypot(settle.dx, settle.dz))} m, tilt ${deg(settle.tilt)} deg`)

  const straight = run(3, { throttle: 1 })
  console.log(`forward 3 s     moved x ${f(straight.dx)} z ${f(straight.dz)}, top ${f(straight.topSpeed)} m/s, bob ${(straight.bob * 1000).toFixed(0)} mm, tilt ${deg(straight.tilt)} deg`)

  home()
  run(1, {})
  const turn = run(3, { throttle: 1, steer: 1 })
  console.log(`left turn 3 s   turned ${deg(turn.turned)} deg, moved x ${f(turn.dx)} z ${f(turn.dz)}, tilt ${deg(turn.tilt)} deg`)

  home()
  run(1, {})
  const reverse = run(2, { throttle: -1 })
  console.log(`reverse 2 s     moved x ${f(reverse.dx)} z ${f(reverse.dz)}`)

  home()
  run(1, {})
  const at = world.lift().position
  const crate = world.addProp({ x: 0.4, y: 0.4, z: 0.4 }, { x: at.x + 3, y: map.floorHeight + 0.45, z: at.z })
  run(3, { throttle: 1 })
  const pushed = crate.body.translation()
  console.log(`push crate 3 s  crate moved x ${f(pushed.x - at.x - 3)} z ${f(pushed.z - at.z)} y ${f(pushed.y)}`)
  world.removeProp(crate)

  home()
  run(1, {})
  const raised = run(14, { raise: 1 })
  console.log(`raise 14 s      deck stopped at ${f(raised.end.deck)} m, body tilt ${deg(raised.tilt)} deg`)
  const crawl = run(3, { throttle: 1 })
  console.log(`raised drive    top ${f(crawl.topSpeed)} m/s, tilt ${deg(crawl.tilt)} deg`)
  run(14, { raise: -1 })

  home()
  run(1, {})
  const start = world.lift().position
  const pinned = world.addProp({ x: 0.4, y: 0.4, z: 0.4 }, { x: start.x + 3, y: map.floorHeight + 0.45, z: start.z })
  const pin = run(20, { throttle: 1 })
  const c = pinned.body.translation()
  const gap = c.x - 0.4 - (pin.end.position.x + 1.22)
  console.log(`pin crate 20 s  crate at x ${f(c.x)} y ${f(c.y)} z ${f(c.z)}, lift at x ${f(pin.end.position.x)}, gap ${f(gap)} m, ${c.x < mesh.max.x && c.y > -0.2 ? 'crate inside' : 'crate ESCAPED'}`)
  world.removeProp(pinned)

  for (const [name, yaw] of [['+x', 0], ['-z', Math.PI / 2], ['-x', Math.PI], ['+z', -Math.PI / 2]] as const) {
    world.respawn(spawn.x, spawn.z, yaw)
    run(1, {})
    const ram = run(20, { throttle: 1 })
    const p = ram.end.position
    const inside = p.x > mesh.min.x && p.x < mesh.max.x && p.z > mesh.min.z && p.z < mesh.max.z
    console.log(`ram ${name} 20 s    stopped at x ${f(p.x)} y ${f(p.y)} z ${f(p.z)}, speed ${f(ram.end.speed)} m/s, tilt ${deg(ram.tilt)} deg, ${inside ? 'inside' : 'OUTSIDE'} the scan`)
  }
}

console.log(`scan x ${f(mesh.min.x)}..${f(mesh.max.x)}, z ${f(mesh.min.z)}..${f(mesh.max.z)}, floor ${f(map.floorHeight)} m, ${world.wallCount} wall boxes`)
console.log(`spawn x ${f(spawn.x)} z ${f(spawn.z)}`)
for (const variant of Object.keys(VARIANTS) as Variant[]) bench(variant)
console.log(`\nstep time ${(stepMs / stepCount).toFixed(3)} ms mean over ${stepCount} steps`)

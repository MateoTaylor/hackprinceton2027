/**
 * A stand-in scissor lift drawn from boxes, shaped by the `LIFT` dimensions the
 * simulation uses. A real model replaces this once it has a rig for the deck.
 *
 *   const lift = createLiftVisual()
 *   scene.add(lift.root)
 *   lift.update(world.lift())     // every frame
 */
import { BoxGeometry, CylinderGeometry, Group, Mesh, MeshStandardMaterial, type Material } from 'three'
import { LIFT, type World } from './world.ts'

const STAGES = 4
const BAR_LENGTH = 2.1
const DECK_THICKNESS = 0.06
const WHEEL_WIDTH = 0.14

const PAINT = new MeshStandardMaterial({ color: 0x1f63b5, roughness: 0.55 })
const STEEL = new MeshStandardMaterial({ color: 0xa3a9b0, roughness: 0.45, metalness: 0.5 })
const RUBBER = new MeshStandardMaterial({ color: 0x17181a, roughness: 0.95 })
const DECK = new MeshStandardMaterial({ color: 0x3a3f45, roughness: 0.8 })

function box(parent: Group, material: Material, size: [number, number, number], at: [number, number, number]) {
  const mesh = new Mesh(new BoxGeometry(...size), material)
  mesh.position.set(...at)
  parent.add(mesh)
  return mesh
}

export function createLiftVisual() {
  const { half, rideHeight, wheelRadius, wheelX, wheelZ, platformHalf } = LIFT
  const root = new Group()

  box(root, PAINT, [half.x * 2, half.y * 2, (wheelZ - WHEEL_WIDTH / 2 - 0.02) * 2], [0, 0, 0])
  box(root, PAINT, [half.x * 2, 0.06, half.z * 2], [0, half.y - 0.03, 0])

  const tire = new CylinderGeometry(wheelRadius, wheelRadius, WHEEL_WIDTH, 24).rotateX(Math.PI / 2)
  const wheels = [wheelX, -wheelX].flatMap((x) =>
    [-wheelZ, wheelZ].map((z) => {
      const pivot = new Group()
      pivot.position.set(x, wheelRadius - rideHeight, z)
      const spin = new Group()
      spin.add(new Mesh(tire, RUBBER))
      box(spin, STEEL, [wheelRadius * 1.3, 0.05, WHEEL_WIDTH + 0.02], [0, 0, 0])
      pivot.add(spin)
      root.add(pivot)
      return { pivot, spin, steers: x > 0 }
    }),
  )

  const bars = Array.from({ length: STAGES }, () =>
    [-1, 1].flatMap((side) =>
      [1, -1].map((lean) => ({
        lean,
        mesh: box(root, STEEL, [BAR_LENGTH, 0.07, 0.04], [0, 0, side * (0.34 + (lean > 0 ? 0.05 : 0))]),
      })),
    ),
  )

  const platform = new Group()
  root.add(platform)
  const railHeight = platformHalf.y * 2
  box(platform, DECK, [platformHalf.x * 2, DECK_THICKNESS, platformHalf.z * 2], [0, -DECK_THICKNESS / 2, 0])
  for (const x of [-platformHalf.x, platformHalf.x]) {
    for (const z of [-platformHalf.z, platformHalf.z]) box(platform, PAINT, [0.04, railHeight, 0.04], [x, railHeight / 2, z])
    for (const y of [railHeight / 2, railHeight]) box(platform, PAINT, [0.03, 0.03, platformHalf.z * 2], [x, y, 0])
  }
  for (const z of [-platformHalf.z, platformHalf.z]) {
    for (const y of [railHeight / 2, railHeight]) box(platform, PAINT, [platformHalf.x * 2, 0.03, 0.03], [0, y, z])
  }

  return {
    root,
    update(lift: ReturnType<World['lift']>) {
      root.position.copy(lift.position)
      root.quaternion.copy(lift.rotation)

      const deckTop = lift.deck - rideHeight
      platform.position.y = deckTop
      const stage = (deckTop - DECK_THICKNESS - half.y) / STAGES
      const angle = Math.asin(Math.min(1, stage / BAR_LENGTH))
      bars.forEach((pair, i) => {
        for (const bar of pair) {
          bar.mesh.position.y = half.y + (i + 0.5) * stage
          bar.mesh.rotation.z = bar.lean * angle
        }
      })

      for (const wheel of wheels) {
        wheel.spin.rotation.z = -lift.travel / wheelRadius
        if (wheel.steers) wheel.pivot.rotation.y = lift.steer
      }
    },
  }
}

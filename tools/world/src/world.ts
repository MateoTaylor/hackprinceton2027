/**
 * The simulation: a scan as an indestructible static world, one drivable scissor lift
 * and loose props. It runs the same in Node and in the browser.
 *
 *   const world = await createWorld(mesh, map, { x: 14, z: 6 })
 *   world.step({ throttle: 1, steer: 0, raise: 0 })   // advances DT seconds
 *   world.lift()                                      // the pose to draw
 *
 * The lift has two motion models behind `setVariant`, so they can be compared by feel.
 * Both share one body layout: local +x is forward, +y is up, the origin is the chassis
 * center.
 */
import RAPIER from '@dimforge/rapier3d-compat'
import type { CollisionMesh, Vec3 } from './collision-mesh.ts'
import { voidRuns, type Drivable } from './drivable.ts'

export const DT = 1 / 60

export const VARIANTS = {
  dynamic: 'A  dynamic body on a raycast vehicle',
  kinematic: 'C  kinematic box with a character controller',
} as const
export type Variant = keyof typeof VARIANTS

/** Each axis runs from -1 to 1. Positive steer turns left. */
export type LiftInput = { throttle: number; steer: number; raise: number }

export const LIFT = {
  half: { x: 1.22, y: 0.25, z: 0.585 },
  /** Height of the chassis center above the ground at rest. */
  rideHeight: 0.385,
  wheelRadius: 0.19,
  wheelX: 0.9,
  wheelZ: 0.5,
  /** The deck and its guard rails, as one box that sits on the deck height. */
  platformHalf: { x: 1.1, y: 0.55, z: 0.5 },
  deckMin: 1.0,
  deckMax: 7.9,
  mass: 2400,
  topSpeed: 3,
  raisedSpeed: 0.8,
  maxSteer: 0.7,
} as const

const FLOOR_DROP = 0.12
const WALL_HEIGHT = 8
const MIN_VOID_AREA = 1
const PROP_DENSITY = 60
const RAISE_SPEED = 0.6
const STEER_RATE = 2.5
const ACCEL = 4
const UP = { x: 0, y: 1, z: 0 }
const DOWN = { x: 0, y: -1, z: 0 }
const STILL = { x: 0, y: 0, z: 0 }

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value))
const yawQuat = (yaw: number) => ({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) })
const heading = (yaw: number) => ({ x: Math.cos(yaw), y: 0, z: -Math.sin(yaw) })
const yawOf = (q: RAPIER.Rotation) => Math.atan2(-2 * (q.x * q.z - q.w * q.y), 1 - 2 * (q.y * q.y + q.z * q.z))

/** Where the deck box and the scissor stack under it sit on the body, for a deck height. */
const upperLayout = (deck: number) => {
  const stackHalfY = (deck - LIFT.rideHeight - LIFT.half.y) / 2
  return { stackHalfY, stackY: LIFT.half.y + stackHalfY, platformY: deck + LIFT.platformHalf.y - LIFT.rideHeight }
}

type LiftModel = {
  body: RAPIER.RigidBody
  platform: RAPIER.Collider
  /** Moves the deck and stretches the scissor stack to fill the gap under it. */
  setDeck(deck: number): void
  /** Applies one step of driving. `steer` is the wheel angle in radians. */
  drive(throttle: number, steer: number, topSpeed: number): void
  dispose(): void
}

/**
 * The lift's three boxes, bottom to top: the chassis, the scissor stack and the deck with
 * its rails. The stack closes the gap under the deck, so nothing passes through the lift.
 */
function liftColliders(world: RAPIER.World, body: RAPIER.RigidBody, deck: number) {
  const { half, platformHalf, mass } = LIFT
  const inertia = {
    x: (mass / 12) * (1 + (2 * half.z) ** 2),
    y: (mass / 12) * ((2 * half.x) ** 2 + (2 * half.z) ** 2),
    z: (mass / 12) * ((2 * half.x) ** 2 + 1),
  }
  const chassis = world.createCollider(
    RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z)
      .setMassProperties(mass, { x: 0, y: -0.2, z: 0 }, inertia, { x: 0, y: 0, z: 0, w: 1 })
      .setFriction(0.2),
    body,
  )
  const start = upperLayout(deck)
  const weightless = (halfY: number, y: number) =>
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(platformHalf.x, halfY, platformHalf.z).setDensity(0).setFriction(0.2).setTranslation(0, y, 0),
      body,
    )
  const stack = weightless(start.stackHalfY, start.stackY)
  const platform = weightless(platformHalf.y, start.platformY)

  return {
    parts: [chassis, stack, platform],
    platform,
    setDeck(next: number) {
      const to = upperLayout(next)
      stack.setHalfExtents({ x: platformHalf.x, y: to.stackHalfY, z: platformHalf.z })
      stack.setTranslationWrtParent({ x: 0, y: to.stackY, z: 0 })
      platform.setTranslationWrtParent({ x: 0, y: to.platformY, z: 0 })
    },
  }
}

function dynamicLift(world: RAPIER.World, at: Vec3, yaw: number, deck: number): LiftModel {
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(at.x, at.y, at.z)
      .setRotation(yawQuat(yaw))
      .setAngularDamping(2)
      .setCcdEnabled(true)
      .setCanSleep(false),
  )
  const { platform, setDeck } = liftColliders(world, body, deck)
  const vehicle = world.createVehicleController(body)
  for (const x of [LIFT.wheelX, -LIFT.wheelX]) {
    for (const z of [-LIFT.wheelZ, LIFT.wheelZ]) {
      vehicle.addWheel({ x, y: -0.1, z }, DOWN, { x: 0, y: 0, z: 1 }, 0.12, LIFT.wheelRadius)
    }
  }
  for (let wheel = 0; wheel < 4; wheel++) {
    vehicle.setWheelSuspensionStiffness(wheel, 100)
    vehicle.setWheelSuspensionCompression(wheel, 8)
    vehicle.setWheelSuspensionRelaxation(wheel, 12)
    vehicle.setWheelMaxSuspensionTravel(wheel, 0.1)
    vehicle.setWheelMaxSuspensionForce(wheel, 100_000)
    vehicle.setWheelFrictionSlip(wheel, 1.5)
    vehicle.setWheelSideFrictionStiffness(wheel, 1)
  }

  return {
    body,
    platform,
    setDeck,
    drive(throttle, steer, topSpeed) {
      const velocity = body.linvel()
      const forward = heading(yawOf(body.rotation()))
      const speed = velocity.x * forward.x + velocity.z * forward.z
      const force = clamp((throttle * topSpeed - speed) * 6000, -12_000, 12_000)
      const parked = throttle === 0 && Math.abs(speed) < 0.2
      for (let wheel = 0; wheel < 4; wheel++) {
        vehicle.setWheelEngineForce(wheel, parked ? 0 : force / 4)
        vehicle.setWheelBrake(wheel, parked ? 100 : 0)
      }
      vehicle.setWheelSteering(0, steer)
      vehicle.setWheelSteering(1, steer)
      vehicle.updateVehicle(DT)
    },
    dispose() {
      world.removeVehicleController(vehicle)
      world.removeRigidBody(body)
    },
  }
}

function kinematicLift(world: RAPIER.World, at: Vec3, startYaw: number, deck: number): LiftModel {
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(at.x, at.y, at.z).setRotation(yawQuat(startYaw)),
  )
  const { parts, platform, setDeck } = liftColliders(world, body, deck)
  const controller = world.createCharacterController(0.02)
  controller.setApplyImpulsesToDynamicBodies(true)
  controller.setCharacterMass(LIFT.mass)

  const others = (collider: RAPIER.Collider) => collider.parent()?.handle !== body.handle
  const fixedOnly = RAPIER.QueryFilterFlags.ONLY_FIXED
  let yaw = startYaw
  let speed = 0

  const fits = (nextYaw: number) => {
    const rotation = yawQuat(nextYaw)
    let free = true
    const blocked = () => (free = false)
    for (const part of parts) {
      const half = part.halfExtents()
      if (!free || !half) continue
      world.intersectionsWithShape(part.translation(), rotation, new RAPIER.Cuboid(half.x, half.y - 0.06, half.z), blocked, fixedOnly)
    }
    return free
  }

  /**
   * The part of `wanted` that every part of the lift can make. One part may slide off an
   * obstacle into another part's wall, so the parts take turns until all of them accept the
   * same movement. If they never agree, as when the lift is wedged between two obstacles, the
   * lift stays where it is.
   */
  const clearMovement = (wanted: RAPIER.Vector) => {
    let moved = wanted
    let agreed = 0
    for (let turn = 0; agreed < parts.length; turn++) {
      if (turn === parts.length * 4) return STILL
      controller.computeColliderMovement(parts[turn % parts.length], moved, undefined, undefined, others)
      const next = controller.computedMovement()
      agreed = Math.hypot(next.x - moved.x, next.y - moved.y, next.z - moved.z) < 1e-5 ? agreed + 1 : 1
      moved = next
    }
    return moved
  }

  const groundUnder = (x: number, y: number, z: number) => {
    const hit = world.castRay(new RAPIER.Ray({ x, y: y + 0.5, z }, DOWN), 3, true, fixedOnly)
    return hit ? y + 0.5 - hit.timeOfImpact : y - LIFT.rideHeight
  }

  return {
    body,
    platform,
    setDeck,
    drive(throttle, steer, topSpeed) {
      speed += clamp(throttle * topSpeed - speed, -ACCEL * DT, ACCEL * DT)
      const turn = ((speed * Math.tan(steer)) / (2 * LIFT.wheelX)) * DT
      if (turn !== 0 && fits(yaw + turn)) yaw += turn

      const forward = heading(yaw)
      const moved = clearMovement({ x: forward.x * speed * DT, y: 0, z: forward.z * speed * DT })
      speed = (moved.x * forward.x + moved.z * forward.z) / DT

      const from = body.translation()
      const x = from.x + moved.x
      const z = from.z + moved.z
      const side = { x: -forward.z, z: forward.x }
      let ground = 0
      for (const along of [LIFT.wheelX, -LIFT.wheelX]) {
        for (const across of [LIFT.wheelZ, -LIFT.wheelZ]) {
          ground += groundUnder(x + forward.x * along + side.x * across, from.y, z + forward.z * along + side.z * across) / 4
        }
      }
      const y = from.y + (ground + LIFT.rideHeight - from.y) * 0.3
      body.setNextKinematicTranslation({ x, y, z })
      body.setNextKinematicRotation(yawQuat(yaw))
    },
    dispose() {
      world.removeCharacterController(controller)
      world.removeRigidBody(body)
    },
  }
}

const MODELS = { dynamic: dynamicLift, kinematic: kinematicLift }

/** The scan mesh, a catch floor just below it, and walls around everything unscanned. */
function addStaticWorld(world: RAPIER.World, mesh: CollisionMesh, map: Drivable) {
  world.createCollider(
    RAPIER.ColliderDesc.trimesh(mesh.positions, mesh.indices, RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES).setFriction(0.9),
  )
  const box = (hx: number, hy: number, hz: number, x: number, y: number, z: number) =>
    world.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(x, y, z))

  const spanX = map.cols * map.cell
  const spanZ = map.rows * map.cell
  const midX = map.originX + spanX / 2
  const midZ = map.originZ + spanZ / 2
  const bottom = map.floorHeight - FLOOR_DROP
  const wallY = bottom + WALL_HEIGHT / 2

  box(spanX / 2 + 1, 0.5, spanZ / 2 + 1, midX, bottom - 0.5, midZ)
  box(0.5, WALL_HEIGHT / 2, spanZ / 2 + 1, map.originX - 0.5, wallY, midZ)
  box(0.5, WALL_HEIGHT / 2, spanZ / 2 + 1, map.originX + spanX + 0.5, wallY, midZ)
  box(spanX / 2 + 1, WALL_HEIGHT / 2, 0.5, midX, wallY, map.originZ - 0.5)
  box(spanX / 2 + 1, WALL_HEIGHT / 2, 0.5, midX, wallY, map.originZ + spanZ + 0.5)

  const runs = voidRuns(map, MIN_VOID_AREA)
  for (const run of runs) {
    const half = ((run.to - run.from + 1) * map.cell) / 2
    box(half, WALL_HEIGHT / 2, map.cell / 2, map.originX + run.from * map.cell + half, wallY, map.originZ + (run.row + 0.5) * map.cell)
  }
  return runs.length
}

export type Prop = { id: number; body: RAPIER.RigidBody; half: Vec3 }
export type World = Awaited<ReturnType<typeof createWorld>>

export async function createWorld(mesh: CollisionMesh, map: Drivable, spawn: { x: number; z: number }) {
  await RAPIER.init()
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 })
  world.timestep = DT
  const wallCount = addStaticWorld(world, mesh, map)

  const platformShape = new RAPIER.Cuboid(LIFT.platformHalf.x, LIFT.platformHalf.y, LIFT.platformHalf.z)
  const restY = map.floorHeight + LIFT.rideHeight + 0.03
  const props = new Map<number, Prop>()
  let variant: Variant = 'dynamic'
  let deck: number = LIFT.deckMin
  let steer = 0
  let travel = 0
  let speed = 0
  let model = MODELS[variant](world, { x: spawn.x, y: restY, z: spawn.z }, 0, deck)

  const place = (next: Variant, at: Vec3, yaw: number) => {
    model.dispose()
    variant = next
    steer = 0
    speed = 0
    model = MODELS[next](world, at, yaw, deck)
  }

  const raise = (amount: number) => {
    let next = clamp(deck + amount * RAISE_SPEED * DT, LIFT.deckMin, LIFT.deckMax)
    if (next > deck) {
      const hit = world.castShape(
        model.platform.translation(),
        model.platform.rotation(),
        UP,
        platformShape,
        0,
        next - deck + 0.05,
        true,
        RAPIER.QueryFilterFlags.ONLY_FIXED,
      )
      if (hit) next = deck + Math.max(0, hit.time_of_impact - 0.05)
    }
    deck = next
    model.setDeck(deck)
  }

  const hasRoom = (half: Vec3, at: Vec3, yaw: number, except?: RAPIER.RigidBody) => {
    const col = (at.x - map.originX) / map.cell
    const row = (at.z - map.originZ) / map.cell
    if (col < 0 || row < 0 || col > map.cols || row > map.rows) return false
    let free = true
    const shape = new RAPIER.Cuboid(half.x, half.y, half.z)
    world.intersectionsWithShape(at, yawQuat(yaw), shape, () => (free = false), undefined, undefined, undefined, except)
    return free
  }

  return {
    wallCount,
    props,
    get variant() {
      return variant
    },

    /** Swaps the motion model and keeps the lift where it is. */
    setVariant(next: Variant) {
      if (next === variant) return
      const at = model.body.translation()
      place(next, { x: at.x, y: at.y, z: at.z }, yawOf(model.body.rotation()))
    },

    /**
     * Puts the lift on the floor at a spot, facing `yaw` radians left of +x, with the
     * deck lowered so it cannot land inside overhead geometry.
     */
    respawn(x: number, z: number, yaw: number) {
      deck = LIFT.deckMin
      place(variant, { x, y: restY, z }, yaw)
    },

    step(input: LiftInput) {
      if (input.raise !== 0) raise(input.raise)
      steer += clamp(input.steer * LIFT.maxSteer - steer, -STEER_RATE * DT, STEER_RATE * DT)
      const before = model.body.translation()
      model.drive(input.throttle, steer, deck > LIFT.deckMin + 0.3 ? LIFT.raisedSpeed : LIFT.topSpeed)
      world.step()
      const after = model.body.translation()
      const forward = heading(yawOf(model.body.rotation()))
      speed = ((after.x - before.x) * forward.x + (after.z - before.z) * forward.z) / DT
      travel += speed * DT
    },

    lift() {
      return { position: model.body.translation(), rotation: model.body.rotation(), deck, steer, travel, speed }
    },

    /** Whether a box centered on `at` is on the map and touches nothing: building, lift or prop. */
    hasRoom(half: Vec3, at: Vec3, yaw = 0) {
      return hasRoom(half, at, yaw)
    },

    /** Adds a loose box. `at` is its center. Check `hasRoom` first, or it may spawn inside something. */
    addProp(half: Vec3, at: Vec3, yaw = 0) {
      const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(at.x, at.y, at.z)
          .setRotation(yawQuat(yaw))
          .setLinearDamping(0.2)
          .setAngularDamping(0.5),
      )
      world.createCollider(RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z).setDensity(PROP_DENSITY).setFriction(0.8), body)
      const prop: Prop = { id: body.handle, body, half }
      props.set(prop.id, prop)
      return prop
    },

    removeProp(prop: Prop) {
      props.delete(prop.id)
      world.removeRigidBody(prop.body)
    },

    /** A held prop ignores gravity and goes where `carry` puts it until `release`. */
    hold(prop: Prop) {
      prop.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true)
    },

    /**
     * Moves a held prop, unless the spot overlaps the building, the lift or another prop,
     * or lies off the map. Returns whether it moved.
     */
    carry(prop: Prop, at: Vec3, yaw: number) {
      if (!hasRoom(prop.half, at, yaw, prop.body)) return false
      prop.body.setNextKinematicTranslation(at)
      prop.body.setNextKinematicRotation(yawQuat(yaw))
      return true
    },

    /** Lets a held prop fall from rest, whatever speed it was carried at. */
    release(prop: Prop) {
      prop.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true)
      prop.body.setLinvel(STILL, true)
      prop.body.setAngvel(STILL, true)
    },

    /** Line segments outlining every collider, as xyz pairs. */
    debugLines() {
      return world.debugRender().vertices
    },
  }
}

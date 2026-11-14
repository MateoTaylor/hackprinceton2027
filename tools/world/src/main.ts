/**
 * The browser view: drive the lift through one textured scan and place props in it.
 * Run `pnpm dev` and open the printed URL. The keys are listed on screen.
 *
 * `?tex=2048` sets the texture width in pixels and `?tex=full` keeps the originals.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  HemisphereLight,
  LineBasicMaterial,
  LineSegments,
  PerspectiveCamera,
  Plane,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { fromScan, parseObj } from './collision-mesh.ts'
import { bakeDrivable, buildBvh } from './drivable.ts'
import { createLiftVisual } from './lift-visual.ts'
import { crate, createPropVisuals, HOVER, loadModel, type PropShape } from './prop-visuals.ts'
import { loadScanView } from './scan-view.ts'
import { createWorld, DT, LIFT, VARIANTS, type Prop, type Variant } from './world.ts'

type Manifest = {
  name: string
  meshes: { path: string; mtl: string | null }[]
  locations: { position: [number, number, number] }[]
}

const UP = new Vector3(0, 1, 0)
const TURN_SPEED = 1.8
const CLICK_SLOP = 4

function element(id: string) {
  const found = document.getElementById(id)
  if (!found) throw new Error(`index.html has no #${id}`)
  return found
}

const hud = {
  model: element('hud-model'),
  speed: element('hud-speed'),
  deck: element('hud-deck'),
  position: element('hud-position'),
  props: element('hud-props'),
  camera: element('hud-camera'),
  step: element('hud-step'),
  fps: element('hud-fps'),
  status: element('hud-status'),
}
const say = (text: string) => (hud.status.textContent = text)

async function loadScan() {
  const manifest: Manifest = await (await fetch(`${__SCAN_BASE__}/manifest.json`)).json()
  const collision = manifest.meshes.find((m) => m.path.endsWith('out_res_50k.obj'))
  const textured = manifest.meshes.find((m) => m.mtl)
  if (!collision || !textured) throw new Error('the scan needs out_res_50k.obj and a textured MatterPak mesh')

  const mesh = parseObj(await (await fetch(`${__SCAN_BASE__}/${collision.path}`)).text())
  const map = bakeDrivable(mesh, buildBvh(mesh), 0.25)
  const mid = { x: (mesh.min.x + mesh.max.x) / 2, z: (mesh.min.z + mesh.max.z) / 2 }
  const spawn = manifest.locations
    .map((l) => fromScan(...l.position))
    .sort((a, b) => Math.hypot(a.x - mid.x, a.z - mid.z) - Math.hypot(b.x - mid.x, b.z - mid.z))[0]
  return { name: manifest.name, mesh, map, spawn, texturedUrl: `${__SCAN_BASE__}/${textured.path}` }
}

function textureWidth() {
  const asked = new URLSearchParams(location.search).get('tex')
  if (asked === 'full') return null
  return Number(asked) || 1024
}

async function main() {
  say('Loading the collision mesh')
  const scan = await loadScan()
  const world = await createWorld(scan.mesh, scan.map, scan.spawn)
  const floor = scan.map.floorHeight
  document.title = `${scan.name} world prototype`

  const renderer = new WebGLRenderer({ antialias: true })
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  renderer.setSize(innerWidth, innerHeight)
  const canvas = renderer.domElement
  document.body.prepend(canvas)

  const scene = new Scene()
  scene.background = new Color(0x0e0f11)
  scene.add(new HemisphereLight(0xffffff, 0x4a4f57, 2.2))
  const sun = new DirectionalLight(0xffffff, 1.6)
  sun.position.set(4, 10, 6)
  scene.add(sun)

  say('Loading the textured mesh')
  const view = loadScanView(scan.texturedUrl, textureWidth(), renderer.capabilities.getMaxAnisotropy())
  scene.add(view.group)
  view.textured.then(
    (count) => say(`Ready. ${count} textures on.`),
    (error) => say(`The textured mesh did not load. ${error}`),
  )

  const liftVisual = createLiftVisual()
  scene.add(liftVisual.root)
  const props = createPropVisuals(scene, world)

  const debug = new LineSegments(new BufferGeometry(), new LineBasicMaterial({ color: 0x3d8bdb }))
  debug.visible = false
  debug.frustumCulled = false
  scene.add(debug)

  const forward = new Vector3()
  const yawOf = (rotation: { x: number; y: number; z: number; w: number }) => {
    forward.set(1, 0, 0).applyQuaternion(rotation)
    return Math.atan2(-forward.z, forward.x)
  }

  const camera = new PerspectiveCamera(60, innerWidth / innerHeight, 0.05, 200)
  const controls = new OrbitControls(camera, canvas)
  controls.enablePan = false
  controls.minDistance = 2
  controls.maxDistance = 60
  controls.maxPolarAngle = Math.PI / 2 - 0.05
  const eye = new Vector3()
  const start = world.lift()
  controls.target.set(start.position.x, start.position.y + 0.8, start.position.z)
  camera.position.copy(controls.target).add(eye.set(-5.5, 1.4, 0))
  let chase = true
  let lastYaw = yawOf(start.rotation)

  /** Keeps the camera's offset from the lift, and turns it with the lift in chase mode. */
  const follow = (at: { x: number; y: number; z: number }, yaw: number) => {
    eye.set(at.x, at.y + 0.8, at.z)
    camera.position.add(eye).sub(controls.target)
    controls.target.copy(eye)
    const turned = Math.atan2(Math.sin(yaw - lastYaw), Math.cos(yaw - lastYaw))
    if (chase) camera.position.sub(eye).applyAxisAngle(UP, turned).add(eye)
    lastYaw = yaw
    controls.update()
  }

  const keys = new Set<string>()
  const axis = (positive: string[], negative: string[]) =>
    Number(positive.some((code) => keys.has(code))) - Number(negative.some((code) => keys.has(code)))

  const pointer = new Vector2()
  const raycaster = new Raycaster()
  const floorPlane = new Plane(UP, -floor)
  let held: { prop: Prop; yaw: number; ground: Vector3 } | null = null
  let pressedAt: { x: number; y: number } | null = null

  const aim = (e: PointerEvent) => {
    pointer.set((e.clientX / innerWidth) * 2 - 1, 1 - (e.clientY / innerHeight) * 2)
    raycaster.setFromCamera(pointer, camera)
  }
  const grab = (prop: Prop) => {
    world.hold(prop)
    const at = prop.body.translation()
    held = { prop, yaw: yawOf(prop.body.rotation()), ground: new Vector3(at.x, floor, at.z) }
    say('Holding a prop. Click to drop it. Q and E turn it. Delete removes it.')
  }
  const drop = () => {
    if (!held) return
    world.release(held.prop)
    held = null
    say('Dropped.')
  }
  const removeHeld = () => {
    if (!held) return
    props.remove(held.prop)
    held = null
    say('Removed.')
  }

  /** Sets a new prop down on the floor in front of the lift, clear of it. Returns whether it fit. */
  const addAhead = (shape: PropShape) => {
    const lift = world.lift()
    const yaw = yawOf(lift.rotation)
    const reach = LIFT.half.x + 0.4 + Math.hypot(shape.half.x, shape.half.z)
    const ground = { x: lift.position.x + forward.x * reach, y: floor, z: lift.position.z + forward.z * reach }
    return props.add(shape, ground, yaw) !== undefined
  }
  const addFile = async (file: File) => {
    const url = URL.createObjectURL(file)
    try {
      const shape = await loadModel(url)
      const size = [shape.half.x, shape.half.y, shape.half.z].map((h) => (h * 2).toFixed(2)).join(' x ')
      say(
        addAhead(shape)
          ? `${file.name} added. Its box is ${size} m.`
          : `${file.name} was not added. Its ${size} m box has no room in front of the lift.`,
      )
    } catch (error) {
      say(`${file.name} did not load. ${error}`)
    } finally {
      URL.revokeObjectURL(url)
    }
  }

  const switchTo = (variant: Variant) => {
    world.setVariant(variant)
    say(`Motion model ${VARIANTS[variant]}`)
  }
  const actions: Record<string, () => void> = {
    Digit1: () => switchTo('dynamic'),
    Digit2: () => switchTo('kinematic'),
    KeyB: () => say(addAhead(crate()) ? 'Crate added.' : 'No room for a crate in front of the lift.'),
    KeyG: () => (debug.visible = !debug.visible),
    KeyC: () => (chase = !chase),
    KeyH: () => world.respawn(scan.spawn.x, scan.spawn.z, 0),
    Delete: removeHeld,
    Backspace: removeHeld,
    Escape: drop,
  }

  window.addEventListener('keydown', (e) => {
    keys.add(e.code)
    if (!e.repeat) actions[e.code]?.()
  })
  window.addEventListener('keyup', (e) => keys.delete(e.code))
  window.addEventListener('blur', () => keys.clear())
  window.addEventListener('resize', () => {
    renderer.setSize(innerWidth, innerHeight)
    camera.aspect = innerWidth / innerHeight
    camera.updateProjectionMatrix()
  })

  canvas.addEventListener('pointermove', (e) => {
    aim(e)
    if (held) raycaster.ray.intersectPlane(floorPlane, held.ground)
  })
  canvas.addEventListener('pointerdown', (e) => (pressedAt = { x: e.clientX, y: e.clientY }))
  canvas.addEventListener('pointerup', (e) => {
    if (!pressedAt || Math.hypot(e.clientX - pressedAt.x, e.clientY - pressedAt.y) > CLICK_SLOP) return
    aim(e)
    if (held) return drop()
    const prop = props.pick(raycaster)
    if (prop) grab(prop)
  })

  window.addEventListener('dragover', (e) => e.preventDefault())
  window.addEventListener('drop', (e) => {
    e.preventDefault()
    const file = e.dataTransfer?.files[0]
    if (file) void addFile(file)
  })
  const picker = element('model-file')
  picker.addEventListener('change', () => {
    const file = picker instanceof HTMLInputElement ? picker.files?.[0] : undefined
    if (file) void addFile(file)
  })

  let last = performance.now()
  let backlog = 0
  let stepMs = 0
  let fps = 60
  let hudAt = 0

  renderer.setAnimationLoop((now) => {
    const seconds = Math.min(0.1, (now - last) / 1000)
    last = now
    backlog += seconds
    fps += (1 / Math.max(seconds, 0.001) - fps) * 0.05

    if (held) {
      held.yaw += axis(['KeyQ'], ['KeyE']) * TURN_SPEED * seconds
      world.carry(held.prop, { x: held.ground.x, y: floor + held.prop.half.y + HOVER, z: held.ground.z }, held.yaw)
    }
    const input = {
      throttle: axis(['KeyW', 'ArrowUp'], ['KeyS', 'ArrowDown']),
      steer: axis(['KeyA', 'ArrowLeft'], ['KeyD', 'ArrowRight']),
      raise: axis(['KeyR'], ['KeyF']),
    }
    while (backlog >= DT) {
      const began = performance.now()
      world.step(input)
      stepMs += (performance.now() - began - stepMs) * 0.05
      backlog -= DT
    }

    const lift = world.lift()
    liftVisual.update(lift)
    props.sync()
    follow(lift.position, yawOf(lift.rotation))
    if (debug.visible) {
      debug.geometry.dispose()
      debug.geometry = new BufferGeometry().setAttribute('position', new BufferAttribute(world.debugLines(), 3))
    }
    renderer.render(scene, camera)

    if (now - hudAt < 100) return
    hudAt = now
    hud.model.textContent = VARIANTS[world.variant]
    hud.speed.textContent = `${lift.speed.toFixed(1)} m/s`
    hud.deck.textContent = `${lift.deck.toFixed(2)} m`
    hud.position.textContent = `x ${lift.position.x.toFixed(1)}  z ${lift.position.z.toFixed(1)}`
    hud.props.textContent = String(world.props.size)
    hud.camera.textContent = chase ? 'chase' : 'free orbit'
    hud.step.textContent = `${stepMs.toFixed(2)} ms`
    hud.fps.textContent = fps.toFixed(0)
  })
}

main().catch((error) => say(`Could not start. ${error}`))

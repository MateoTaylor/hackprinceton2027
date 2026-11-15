import { N8AOPostPass } from 'n8ao'
import { EffectComposer, EffectPass, RenderPass, SMAAEffect } from 'postprocessing'
import {
  Box3,
  Color,
  DirectionalLight,
  Group,
  HalfFloatType,
  HemisphereLight,
  InstancedMesh,
  Line,
  Mesh,
  OrthographicCamera,
  PCFShadowMap,
  Raycaster,
  Vector2,
  Scene,
  Sphere,
  Texture,
  Vector3,
  WebGLRenderer,
  type Object3D,
} from 'three'
import { MapControls } from 'three/examples/jsm/controls/MapControls.js'
import type { Look } from './looks.ts'
import { toScene } from './massing.ts'

// One thing to draw. A layer with `onStorey` shows only while that storey is open.
export type StageLayer = { id: string; object: Object3D; onStorey?: number }

// What the pointer is over: the storey and space of the floor it hit, and the point on that
// floor as `[x, y]` in the building frame. `spaceId` is null off every space.
export type Pick = { storeyIndex: number; spaceId: string | null; at: [number, number] }

// Called with a click on a floor, and with every move over the canvas (`null` off every floor).
export type StageHandlers = { onPick?: (pick: Pick) => void; onHover?: (pick: Pick | null) => void }

const DEG = Math.PI / 180
const CAMERA_DISTANCE_M = 1000
const FRAME_PADDING = 1.1
const SUN = { bearingDeg: 160, elevationDeg: 55 }
const SHADOW_MAP_PX = 2048
const CLICK_SLOP_PX = 4

function bearingVector(bearingDeg: number, elevationDeg: number) {
  const [bearing, elevation] = [bearingDeg * DEG, elevationDeg * DEG]
  return toScene(Math.sin(bearing) * Math.cos(elevation), Math.cos(bearing) * Math.cos(elevation), Math.sin(elevation))
}

// Frees what a layer owns. A geometry or material with `userData.shared` set comes from a cache
// that other layers and pages still draw with, so it and its textures are left alone.
function disposeObject(object: Object3D) {
  object.traverse((node) => {
    if (!(node instanceof Mesh || node instanceof Line)) return
    if (node instanceof InstancedMesh) node.dispose()
    if (!node.geometry.userData.shared) node.geometry.dispose()
    for (const material of [node.material].flat()) {
      if (material.userData.shared) continue
      for (const value of Object.values(material)) if (value instanceof Texture) value.dispose()
      material.dispose()
    }
  })
}

// Draws layers on a canvas at the look's fixed isometric angle. The camera never orbits: drag
// pans and the wheel zooms. Layers that leave through `setLayers` are freed, and `dispose` frees
// everything, so the caller never frees a layer it handed over.
//   const stage = createStage(canvas, DEFAULT_LOOK)
//   stage.setLayers([{ id: 'massing', object }])
//   stage.frame(new Box3().setFromObject(object))
export function createStage(canvas: HTMLCanvasElement, look: Look) {
  const renderer = new WebGLRenderer({ canvas, powerPreference: 'high-performance', antialias: false, stencil: false, depth: false })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = PCFShadowMap

  const scene = new Scene()
  scene.background = new Color(look.palette.background)
  const sun = new DirectionalLight('#FFFFFF', 2)
  sun.castShadow = true
  sun.shadow.mapSize.set(SHADOW_MAP_PX, SHADOW_MAP_PX)
  sun.shadow.bias = -0.0005
  sun.shadow.normalBias = 0.05
  const layerRoot = new Group()
  scene.add(new HemisphereLight('#FFFFFF', look.palette.background, 1.2), sun, sun.target, layerRoot)

  const camera = new OrthographicCamera(-1, 1, 1, -1, 1, 2 * CAMERA_DISTANCE_M)
  const view = bearingVector(look.azimuthDeg, -look.elevationDeg)
  const controls = new MapControls(camera, canvas)
  controls.enableRotate = false
  controls.zoomToCursor = true

  const composer = new EffectComposer(renderer, { frameBufferType: HalfFloatType })
  const ao = new N8AOPostPass(scene, camera)
  ao.setQualityMode('Medium')
  ao.configuration.aoRadius = 2
  ao.configuration.distanceFalloff = 1
  ao.configuration.intensity = 3
  composer.addPass(new RenderPass(scene, camera))
  composer.addPass(ao)
  composer.addPass(new EffectPass(camera, new SMAAEffect()))

  let frameRequest = 0
  const render = () => {
    frameRequest = 0
    composer.render()
  }
  const invalidate = () => {
    frameRequest ||= requestAnimationFrame(render)
  }
  controls.addEventListener('change', invalidate)

  const aim = (target: Vector3) => {
    controls.target.copy(target)
    camera.position.copy(target).addScaledVector(view, -CAMERA_DISTANCE_M)
    camera.lookAt(target)
    camera.updateMatrixWorld()
  }
  aim(new Vector3())

  const resize = (width: number, height: number) => {
    composer.setSize(width, height, false)
    const aspect = width / Math.max(height, 1)
    camera.left = -aspect
    camera.right = aspect
    camera.updateProjectionMatrix()
    invalidate()
  }
  resize(canvas.clientWidth, canvas.clientHeight)

  let storey: number | null = null
  const showStorey = () => {
    for (const child of layerRoot.children) {
      const onStorey = child.userData.onStorey
      child.visible = typeof onStorey !== 'number' || onStorey === storey
    }
    invalidate()
  }

  let handlers: StageHandlers = {}
  const raycaster = new Raycaster()
  const pointer = new Vector2()
  const pickAt = (event: PointerEvent): Pick | null => {
    const rect = canvas.getBoundingClientRect()
    pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1)
    raycaster.setFromCamera(pointer, camera)
    const floors: Object3D[] = []
    for (const layer of layerRoot.children) {
      if (!layer.visible) continue
      layer.traverseVisible((node) => {
        if (node instanceof Mesh && typeof node.userData.storeyIndex === 'number') floors.push(node)
      })
    }
    const hit = raycaster.intersectObjects(floors, false).find(({ object }) => 'spaceId' in object.userData)
    if (!hit) return null
    const { storeyIndex, spaceId } = hit.object.userData
    if (typeof storeyIndex !== 'number' || !(typeof spaceId === 'string' || spaceId === null)) return null
    return { storeyIndex, spaceId, at: [hit.point.x, -hit.point.z] }
  }
  let down: { x: number; y: number } | null = null
  const onDown = (event: PointerEvent) => {
    down = { x: event.clientX, y: event.clientY }
  }
  const onUp = (event: PointerEvent) => {
    const moved = down ? Math.hypot(event.clientX - down.x, event.clientY - down.y) : Infinity
    down = null
    if (moved > CLICK_SLOP_PX || !handlers.onPick) return
    const pick = pickAt(event)
    if (pick) handlers.onPick(pick)
  }
  const onMove = (event: PointerEvent) => {
    if (event.buttons === 0) handlers.onHover?.(pickAt(event))
  }
  const onLeave = () => handlers.onHover?.(null)
  canvas.addEventListener('pointerdown', onDown)
  canvas.addEventListener('pointerup', onUp)
  canvas.addEventListener('pointermove', onMove)
  canvas.addEventListener('pointerleave', onLeave)

  return {
    resize,
    setLayers(layers: StageLayer[]) {
      const kept = new Set(layers.map(({ object }) => object))
      for (const child of [...layerRoot.children]) {
        if (kept.has(child)) continue
        layerRoot.remove(child)
        disposeObject(child)
      }
      for (const { object, onStorey } of layers) {
        object.userData.onStorey = onStorey
        layerRoot.add(object)
      }
      showStorey()
    },
    // Shows only the `onStorey` layers of this storey, and every layer without one.
    setStorey(index: number | null) {
      storey = index
      showStorey()
    },
    // Replaces the pick and hover callbacks. A click is a press and release that moves under 4 px.
    setHandlers(next: StageHandlers) {
      handlers = next
    },
    // Centres the view on a box in scene coordinates and zooms until it fits, then sizes the
    // sun's shadow to cover it.
    frame(box: Box3) {
      const centre = box.getCenter(new Vector3())
      aim(centre)
      const { min, max } = box.clone().applyMatrix4(camera.matrixWorldInverse)
      const halfWidth = Math.max(-min.x, max.x)
      const halfHeight = Math.max(-min.y, max.y)
      camera.zoom = Math.min(camera.right / halfWidth, camera.top / halfHeight) / FRAME_PADDING
      controls.minZoom = camera.zoom / 4
      controls.maxZoom = camera.zoom * 20
      camera.updateProjectionMatrix()

      const radius = box.getBoundingSphere(new Sphere()).radius
      sun.target.position.copy(centre)
      sun.position.copy(centre).addScaledVector(bearingVector(SUN.bearingDeg, SUN.elevationDeg), 2 * radius)
      Object.assign(sun.shadow.camera, { left: -radius, right: radius, top: radius, bottom: -radius, near: 0.1, far: 4 * radius })
      sun.shadow.camera.updateProjectionMatrix()
      invalidate()
    },
    dispose() {
      cancelAnimationFrame(frameRequest)
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerleave', onLeave)
      controls.dispose()
      disposeObject(layerRoot)
      sun.dispose()
      composer.dispose()
      renderer.dispose()
    },
  }
}

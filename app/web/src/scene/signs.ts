import type * as THREE from 'three'
import type { SceneHandle } from './host'
import { classifyNormal, formatLength, groundProbes, SIGN_DEPTH_M, signMeasures, type Measure, type PlacedSign } from './signGeometry'

const FACE = '#f2f3f5'
const FRAME = '#2a2d32'
const FRAME_M = 0.03
const LINE_RADIUS_M = 0.012
const ON_TOP = 1000

// The scan surface under a pointer, with its normal turned toward the camera, or null over
// empty space. `x` and `y` run from -1 to 1 across the viewer, with y up.
//
// The viewer swaps `raycast` on its own meshes, so this calls the stock one.
export function surfaceAt(handle: SceneHandle, pointer: { x: number; y: number }) {
  const { three } = handle
  const raycaster = new three.Raycaster()
  raycaster.setFromCamera(new three.Vector2(pointer.x, pointer.y), handle.camera)
  const hit = nearestHit(handle, raycaster)
  if (!hit?.face) return null
  const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld)
  if (normal.dot(raycaster.ray.direction) > 0) normal.negate()
  return { point: hit.point.toArray(), normal: normal.toArray() }
}

// The height of the ground under a sign, or undefined when no floor lies below it.
export function groundBelow(handle: SceneHandle, sign: PlacedSign) {
  const { three } = handle
  const down = new three.Vector3(0, -1, 0)
  for (const probe of groundProbes(sign)) {
    const hit = nearestHit(handle, new three.Raycaster(new three.Vector3(...probe), down))
    if (!hit?.face) continue
    const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld)
    if (classifyNormal([normal.x, Math.abs(normal.y), normal.z]) === 'floor') return hit.point.y
  }
  return undefined
}

function nearestHit(handle: SceneHandle, raycaster: THREE.Raycaster) {
  const hits: THREE.Intersection[] = []
  for (const mesh of handle.meshes()) handle.three.Mesh.prototype.raycast.call(mesh, raycaster, hits)
  return hits.sort((a, b) => a.distance - b.distance).at(0)
}

// Draws placed signs and one sign's measurement lines inside the viewer:
//   const layer = createSignLayer(handle)
//   layer.show(signs, selectedSign)   // call again after every change; null hides the lines
//   layer.dispose()                   // before the handle is disposed
export function createSignLayer(handle: SceneHandle) {
  const { three } = handle
  const root = new three.Group()
  handle.scene.add(root)

  const textures: THREE.Texture[] = []

  const clear = () => {
    root.traverse((object) => {
      if (!(object instanceof three.Mesh || object instanceof three.Sprite)) return
      if (object instanceof three.Mesh) object.geometry.dispose()
      for (const material of [object.material].flat()) material.dispose()
    })
    for (const texture of textures.splice(0)) texture.dispose()
    root.clear()
  }

  return {
    show(signs: PlacedSign[], measured: PlacedSign | null) {
      clear()
      for (const sign of signs) root.add(signObject(three, sign))
      if (measured) for (const measure of signMeasures(measured)) root.add(measureObject(three, measure, textures))
    },
    dispose() {
      clear()
      root.removeFromParent()
    },
  }
}

// A blank panel in a dark frame. Its origin is the centre of its back face and +X points away
// from the wall.
function signObject(three: typeof THREE, { position, yawDeg, sizeM: { widthM, heightM } }: PlacedSign) {
  const group = new three.Group()
  const frame = new three.Mesh(new three.BoxGeometry(SIGN_DEPTH_M, heightM, widthM), new three.MeshBasicMaterial({ color: FRAME }))
  frame.position.x = SIGN_DEPTH_M / 2
  const face = new three.Mesh(new three.PlaneGeometry(widthM - 2 * FRAME_M, heightM - 2 * FRAME_M), new three.MeshBasicMaterial({ color: FACE }))
  face.position.x = SIGN_DEPTH_M + 0.002
  face.rotation.y = Math.PI / 2
  group.add(frame, face)
  group.position.set(...position)
  group.rotation.y = (yawDeg * Math.PI) / 180
  return group
}

// A white line with a dot at each end and its length on a dark pill, all drawn over the scan.
function measureObject(three: typeof THREE, { from, to, lengthM }: Measure, textures: THREE.Texture[]) {
  const group = new three.Group()
  const material = new three.MeshBasicMaterial({ color: FACE, depthTest: false })
  const start = new three.Vector3(...from)
  const end = new three.Vector3(...to)
  const line = new three.Mesh(new three.CylinderGeometry(LINE_RADIUS_M, LINE_RADIUS_M, start.distanceTo(end), 8), material)
  line.position.copy(start).lerp(end, 0.5)
  line.quaternion.setFromUnitVectors(new three.Vector3(0, 1, 0), end.clone().sub(start).normalize())
  const dots = [start, end].map((point) => {
    const dot = new three.Mesh(new three.SphereGeometry(LINE_RADIUS_M * 2.5, 12, 8), material.clone())
    dot.position.copy(point)
    return dot
  })
  const label = labelSprite(three, formatLength(lengthM), textures)
  label.position.copy(line.position)
  group.add(line, ...dots, label)
  group.traverse((object) => (object.renderOrder = ON_TOP))
  label.renderOrder = ON_TOP + 1
  return group
}

// Text on a dark pill that keeps its size on screen however far away it is. Its texture is added
// to `textures` for the caller to dispose.
function labelSprite(three: typeof THREE, text: string, textures: THREE.Texture[]) {
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')!
  const font = "600 30px 'Inter Variable', Inter, system-ui, sans-serif"
  context.font = font
  const height = 56
  const width = Math.ceil(context.measureText(text).width) + 40
  canvas.width = width
  canvas.height = height
  context.fillStyle = 'rgba(14, 15, 17, 0.92)'
  context.beginPath()
  context.roundRect(0, 0, width, height, height / 2)
  context.fill()
  context.font = font
  context.fillStyle = FACE
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.fillText(text, width / 2, height / 2 + 1)
  const texture = new three.CanvasTexture(canvas)
  texture.colorSpace = three.SRGBColorSpace
  textures.push(texture)
  const sprite = new three.Sprite(new three.SpriteMaterial({ map: texture, depthTest: false, sizeAttenuation: false }))
  const scale = 0.08
  sprite.scale.set((scale * width) / height, scale, 1)
  return sprite
}

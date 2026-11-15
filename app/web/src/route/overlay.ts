import { type Camera, CanvasTexture, Group, InstancedMesh, Matrix4, MeshBasicMaterial, OrthographicCamera, SphereGeometry, Sprite, SpriteMaterial, type WebGLRenderer } from 'three'
import type { RouteDetail } from '../../../server/src/ops/route/index.ts'
import { type Look, type StageLayer, toScene } from '../dollhouse/index.ts'
import { CONFIDENCE_BANDS, type ConfidenceBand, confidenceBand, type DoorMark, resampleTrail, walkReveal } from './trail.ts'

const DOT_RADIUS_M = 0.08
const DOT_LIFT_M = 0.15
const MARK_SIZE_M = 0.6
const MARK_LIFT_M = 0.4
const MARK_PX = 64
const DOT_MIN_PX = 3
const MARK_MIN_PX = 22

// The metres one screen pixel spans, so a mark can keep a readable size when the view is zoomed
// out to a whole block. Only the stage's orthographic camera has a fixed scale; any other gives 0.
function metresPerPixel(renderer: WebGLRenderer, camera: Camera) {
  if (!(camera instanceof OrthographicCamera)) return 0
  return (camera.top - camera.bottom) / (camera.zoom * Math.max(renderer.domElement.clientHeight, 1))
}

// The trail and the door marks of one storey, for the stage. Dots and marks are drawn at their
// size in metres, but never smaller than a few pixels, and over walls so the route always reads.
// The stage frees what it is handed, so the dot trail is new on every call; the six door
// materials are shared and the stage never frees a sprite's material. `show(progress)` hides the
// dots and marks a walk from the entrance has not reached yet (see walkReveal) and returns the
// marks it shows, with where each is drawn, for hit-testing a hover. Redraw the stage after it
// (the Dollhouse's `revision`), since the stage draws only on demand. `dotCount` sizes the walk (walkMs).
//   const storey = routeLayer(detail, DEFAULT_LOOK, 5, storeys[5].elevationM, result.confidence)
//   const shown = storey.show(0.5)
export function routeLayer(detail: RouteDetail, look: Look, storeyIndex: number, elevationM: number, confidence: number) {
  const dots = resampleTrail(detail.trail, storeyIndex)
  const trail = dotTrail(dots, elevationM + DOT_LIFT_M, CONFIDENCE_BANDS[confidenceBand(confidence)])

  const group = new Group()
  const marks: DoorMark[] = []
  const sprites: Sprite[] = []
  const liftM = look.wallStubM + MARK_LIFT_M
  for (const door of detail.doors) {
    if (door.storeyIndex !== storeyIndex) continue
    const mark: DoorMark = { door, at: door.at, liftM, sizeM: MARK_SIZE_M }
    const sprite = new Sprite(markMaterial(door.verdict, confidenceBand(door.confidence)))
    sprite.position.copy(toScene(door.at[0], door.at[1], elevationM + liftM))
    sprite.renderOrder = 10
    // The renderer has already taken the world matrix by now, so it is updated here too, or the
    // mark would draw at last frame's size (1 m on its first frame).
    sprite.onBeforeRender = (renderer, _, camera) => {
      mark.sizeM = Math.max(MARK_SIZE_M, MARK_MIN_PX * metresPerPixel(renderer, camera))
      sprite.scale.set(mark.sizeM, mark.sizeM, 1)
      sprite.updateMatrixWorld()
    }
    group.add(sprite)
    sprites.push(sprite)
    marks.push(mark)
  }
  const layers: StageLayer[] = [
    { id: `route-trail-${storeyIndex}`, object: trail, onStorey: storeyIndex },
    { id: `route-doors-${storeyIndex}`, object: group, onStorey: storeyIndex },
  ]
  const show = (progress: number) => {
    const reveal = walkReveal(dots, marks.map(({ at }) => at), progress)
    trail.count = reveal.dots
    sprites.forEach((sprite, i) => (sprite.visible = reveal.marks[i]))
    return marks.filter((_, i) => reveal.marks[i])
  }
  return { layers, show, dotCount: dots.length }
}

// One sphere per dot, placed once. The radius is a shader uniform set just before each draw:
// instance matrices written in onBeforeRender reach the GPU only on the next frame, so the first
// frame drew every dot unplaced, stacked into one 2 m ball at the building's origin, which stayed
// until the view next moved.
function dotTrail(dots: [number, number][], liftM: number, color: string) {
  const radius = { value: DOT_RADIUS_M }
  const material = new MeshBasicMaterial({ color, depthTest: false })
  material.onBeforeCompile = (shader) => {
    shader.uniforms.dotRadius = radius
    shader.vertexShader = `uniform float dotRadius;\n${shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed *= dotRadius;')}`
  }
  const trail = new InstancedMesh(new SphereGeometry(1, 12, 8), material, dots.length)
  const matrix = new Matrix4()
  dots.forEach(([x, y], i) => trail.setMatrixAt(i, matrix.setPosition(toScene(x, y, liftM))))
  trail.renderOrder = 9
  trail.frustumCulled = false
  trail.onBeforeRender = (renderer, _, camera) => {
    radius.value = Math.max(DOT_RADIUS_M, DOT_MIN_PX * metresPerPixel(renderer, camera))
  }
  return trail
}

const materials = new Map<string, SpriteMaterial>()

function markMaterial(verdict: 'pass' | 'fail', band: ConfidenceBand) {
  const key = `${verdict}:${band}`
  const known = materials.get(key)
  if (known) return known
  const material = new SpriteMaterial({ map: markTexture(verdict), color: CONFIDENCE_BANDS[band], depthTest: false, transparent: true })
  materials.set(key, material)
  return material
}

const textures = new Map<'pass' | 'fail', CanvasTexture>()

// A white disc with a dark tick or cross. The sprite's colour tints the disc to the door's band.
function markTexture(verdict: 'pass' | 'fail') {
  const known = textures.get(verdict)
  if (known) return known
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = MARK_PX
  const context = canvas.getContext('2d')
  if (!context) throw new Error('This browser cannot draw a 2D canvas.')
  const s = MARK_PX / 64
  context.fillStyle = '#FFFFFF'
  context.beginPath()
  context.arc(32 * s, 32 * s, 30 * s, 0, 2 * Math.PI)
  context.fill()
  context.strokeStyle = '#0E0F11'
  context.lineWidth = 7 * s
  context.lineCap = context.lineJoin = 'round'
  context.beginPath()
  if (verdict === 'pass') {
    context.moveTo(19 * s, 33 * s)
    context.lineTo(28 * s, 42 * s)
    context.lineTo(45 * s, 23 * s)
  } else {
    context.moveTo(22 * s, 22 * s)
    context.lineTo(42 * s, 42 * s)
    context.moveTo(42 * s, 22 * s)
    context.lineTo(22 * s, 42 * s)
  }
  context.stroke()
  const texture = new CanvasTexture(canvas)
  textures.set(verdict, texture)
  return texture
}

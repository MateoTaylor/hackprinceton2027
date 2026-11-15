import { EdgesGeometry, ExtrudeGeometry, Group, LineBasicMaterial, LineSegments, Matrix4, Mesh, Shape, ShapeGeometry, Vector2, Vector3, type Material } from 'three'
import type { BuildingModel, Ring } from '../../../server/src/model/building.ts'
import { ringBounds } from '../../../server/src/model/geo.ts'
import type { Look } from './looks.ts'
import { protoMaterial } from './protoGrid.ts'

const GROUND_MARGIN_M = 12

export const toScene = (x: number, y: number, z: number) => new Vector3(x, z, -y)

// Turns geometry built in the building frame (east, north, up) into scene coordinates.
export const MODEL_TO_SCENE = new Matrix4().makeBasis(toScene(1, 0, 0), toScene(0, 1, 0), toScene(0, 0, 1))

export function massingParts({ shell, context }: BuildingModel) {
  return [
    ...shell.volumes.map(({ id, ring, baseM, topM }) => ({ id, ring, baseM, topM, tone: 'high' as const })),
    ...context.map(({ ring, heightM }, i) => ({ id: `context-${i}`, ring, baseM: 0, topM: heightM, tone: 'context' as const })),
  ]
}

export const shapeOf = (ring: Ring) => new Shape(ring.map(([x, y]) => new Vector2(x, y)))

function groundRing(rings: Ring[]): Ring {
  const bounds = rings.map(ringBounds)
  const minX = Math.floor(Math.min(...bounds.map((b) => b.minX)) - GROUND_MARGIN_M)
  const minY = Math.floor(Math.min(...bounds.map((b) => b.minY)) - GROUND_MARGIN_M)
  const maxX = Math.ceil(Math.max(...bounds.map((b) => b.maxX)) + GROUND_MARGIN_M)
  const maxY = Math.ceil(Math.max(...bounds.map((b) => b.maxY)) + GROUND_MARGIN_M)
  return [
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY],
  ]
}

// A ring extruded from `baseM` to `topM` as one shadowed mesh with dark edges, in scene coordinates.
//   group.add(extrudeRing(storey.ring, 0, 3.5, protoMaterial('high', look), look))
export function extrudeRing(ring: Ring, baseM: number, topM: number, material: Material, look: Look) {
  const geometry = new ExtrudeGeometry(shapeOf(ring), { depth: topM - baseM, bevelEnabled: false })
  geometry.translate(0, 0, baseM)
  geometry.applyMatrix4(MODEL_TO_SCENE)
  const mesh = new Mesh(geometry, material)
  mesh.castShadow = mesh.receiveShadow = true
  mesh.add(new LineSegments(new EdgesGeometry(geometry), new LineBasicMaterial({ color: look.palette.outline })))
  return mesh
}

// The gridded ground plate under a building and its neighbours.
export function buildGround(building: BuildingModel, look: Look) {
  const ground = new Mesh(new ShapeGeometry(shapeOf(groundRing(massingParts(building).map(({ ring }) => ring)))), protoMaterial('context', look))
  ground.geometry.applyMatrix4(MODEL_TO_SCENE)
  ground.name = 'ground'
  ground.receiveShadow = true
  return ground
}

// The building as grey prototype massing on a gridded ground, in scene coordinates.
export function buildMassing(building: BuildingModel, look: Look) {
  const group = new Group()
  for (const part of massingParts(building)) {
    const mesh = extrudeRing(part.ring, part.baseM, part.topM, protoMaterial(part.tone, look), look)
    mesh.name = part.id
    group.add(mesh)
  }
  group.add(buildGround(building, look))
  return group
}

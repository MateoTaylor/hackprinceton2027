import { BoxGeometry, BufferGeometry, Color, CylinderGeometry, InstancedMesh, Matrix4, MeshStandardMaterial, Quaternion, Vector3 } from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { Storey } from '../../../server/src/model/building.ts'
import { FURNISHING_FOOTPRINTS, type Footprint, type FurnishingKind } from '../../../server/src/model/furnishings.ts'
import { styleFor } from './inferredStyle.ts'
import type { FurnitureTone, Look } from './looks.ts'
import { toScene } from './massing.ts'
import type { StageLayer } from './stage.ts'

// One furnishing model: its colour key and a builder that returns its shape in scene metres
// (x east, y up, z south), centred on its footprint and standing on y = 0.
export type KitEntry = { kind: FurnishingKind; tone: FurnitureTone; build: (footprint: Footprint) => BufferGeometry }

// A model ready to instance, by kind.
export type Kit = ReadonlyMap<FurnishingKind, { geometry: BufferGeometry; tone: FurnitureTone }>

// A box `w` wide (x), `h` tall and `d` deep (z), with its base centre at `x`, `y`, `z`.
const box = (w: number, h: number, d: number, x = 0, y = 0, z = 0) => new BoxGeometry(w, h, d).translate(x, y + h / 2, z)
const cylinder = (r: number, h: number, x = 0, y = 0, z = 0) => new CylinderGeometry(r, r, h, 16).translate(x, y + h / 2, z)
const merge = (parts: BufferGeometry[]) => {
  const merged = mergeGeometries(parts.map((part) => part.toNonIndexed()))
  for (const part of parts) part.dispose()
  return merged
}

const LEG = 0.05
const legs = (w: number, d: number, h: number) =>
  [-1, 1].flatMap((sx) => [-1, 1].map((sz) => box(LEG, h, LEG, (sx * (w - LEG)) / 2, 0, (sz * (d - LEG)) / 2)))
const tableShape = ({ widthM: w, depthM: d, heightM: h }: Footprint) => merge([box(w, 0.04, d, 0, h - 0.04), ...legs(w, d, h - 0.04)])

// Every kind in FURNISHING_KINDS as a shape of boxes and cylinders, so no model file is needed.
export const KIT: readonly KitEntry[] = [
  { kind: 'desk', tone: 'wood', build: (f) => merge([box(f.widthM, 0.04, f.depthM, 0, f.heightM - 0.04), box(0.04, f.heightM - 0.04, f.depthM, -(f.widthM - 0.04) / 2), box(0.04, f.heightM - 0.04, f.depthM, (f.widthM - 0.04) / 2)]) },
  { kind: 'chair', tone: 'fabric', build: (f) => merge([box(f.widthM, 0.08, f.depthM, 0, 0.42), box(f.widthM, f.heightM - 0.5, 0.08, 0, 0.5, (f.depthM - 0.08) / 2), ...legs(f.widthM, f.depthM, 0.42)]) },
  { kind: 'table', tone: 'wood', build: tableShape },
  { kind: 'conference_table', tone: 'wood', build: tableShape },
  { kind: 'sofa', tone: 'fabric', build: (f) => merge([box(f.widthM, 0.42, f.depthM), box(f.widthM, f.heightM - 0.42, 0.22, 0, 0.42, (f.depthM - 0.22) / 2), box(0.2, 0.2, f.depthM, -(f.widthM - 0.2) / 2, 0.42), box(0.2, 0.2, f.depthM, (f.widthM - 0.2) / 2, 0.42)]) },
  { kind: 'bed', tone: 'white', build: (f) => merge([box(f.widthM, 0.45, f.depthM), box(f.widthM, f.heightM, 0.08, 0, 0, (f.depthM - 0.08) / 2), box(f.widthM * 0.8, 0.1, 0.4, 0, 0.45, (f.depthM - 0.6) / 2)]) },
  { kind: 'shelf', tone: 'wood', build: (f) => merge([0, 0.25, 0.5, 0.75, 1].map((t) => box(f.widthM, 0.03, f.depthM, 0, t * (f.heightM - 0.03))).concat([box(0.03, f.heightM, f.depthM, -(f.widthM - 0.03) / 2), box(0.03, f.heightM, f.depthM, (f.widthM - 0.03) / 2)])) },
  { kind: 'counter', tone: 'white', build: (f) => merge([box(f.widthM, f.heightM - 0.04, f.depthM - 0.04), box(f.widthM, 0.04, f.depthM, 0, f.heightM - 0.04)]) },
  { kind: 'toilet', tone: 'white', build: (f) => merge([box(f.widthM, f.heightM, 0.18, 0, 0, (f.depthM - 0.18) / 2), box(f.widthM * 0.9, 0.42, f.depthM - 0.18, 0, 0, -0.09)]) },
  { kind: 'sink', tone: 'white', build: (f) => merge([box(f.widthM, 0.15, f.depthM, 0, f.heightM - 0.15), box(0.12, f.heightM - 0.15, 0.12)]) },
  { kind: 'plant', tone: 'green', build: (f) => merge([cylinder(f.widthM * 0.3, 0.4), cylinder(f.widthM / 2, f.heightM - 0.4, 0, 0.4)]) },
  { kind: 'rack', tone: 'metal', build: (f) => merge([0.15, 1.5, 2.85, 4.2].map((y) => box(f.widthM, 0.08, f.depthM, 0, y)).concat(legs(f.widthM, f.depthM, f.heightM))) },
  { kind: 'pallet', tone: 'wood', build: (f) => merge([box(f.widthM, 0.15, f.depthM), box(f.widthM * 0.95, f.heightM - 0.15, f.depthM * 0.95, 0, 0.15)]) },
  { kind: 'crate', tone: 'wood', build: (f) => box(f.widthM, f.heightM, f.depthM) },
  { kind: 'machine', tone: 'metal', build: (f) => merge([box(f.widthM, f.heightM * 0.7, f.depthM), cylinder(f.depthM * 0.3, f.heightM * 0.3, f.widthM * 0.2, f.heightM * 0.7)]) },
]

// Builds every kit shape once at the size of its kind in FURNISHING_FOOTPRINTS, because the
// server placed each furnishing by that footprint. Its geometry is marked shared, so a stage that
// drops a furnishing layer leaves it for the next storey.
//   const kit = loadKit()
export function loadKit(): Kit {
  return new Map(
    KIT.map(({ kind, tone, build }) => {
      const geometry = build(FURNISHING_FOOTPRINTS[kind])
      geometry.userData.shared = true
      return [kind, { geometry, tone }]
    }),
  )
}

const UP = new Vector3(0, 1, 0)

// The furnishings of one storey as one InstancedMesh per kind, all sharing one white material.
// Each instance takes its kit colour, or the grey of an inferred space it stands in.
//   stage.setLayers([...buildFurnishings(storey, kit, look)])
export function buildFurnishings(storey: Storey, kit: Kit, look: Look): StageLayer[] {
  const material = new MeshStandardMaterial({ color: '#FFFFFF', roughness: look.roughness })
  const spaces = new Map(storey.spaces.map((space) => [space.id, styleFor(space, look)]))
  const matrix = new Matrix4()
  const turn = new Quaternion()
  const scale = new Vector3(1, 1, 1)
  const colour = new Color()
  const byKind = new Map<FurnishingKind, Storey['furnishings']>()
  for (const item of storey.furnishings) byKind.set(item.kind, [...(byKind.get(item.kind) ?? []), item])
  return [...byKind].flatMap(([kind, items]) => {
    const model = kit.get(kind)
    if (!model) return []
    const mesh = new InstancedMesh(model.geometry, material, items.length)
    for (const [i, { at, yawDeg, spaceId }] of items.entries()) {
      turn.setFromAxisAngle(UP, (yawDeg * Math.PI) / 180)
      mesh.setMatrixAt(i, matrix.compose(toScene(at[0], at[1], storey.elevationM), turn, scale))
      mesh.setColorAt(i, colour.set(spaces.get(spaceId)?.furnitureColor ?? look.palette.furniture[model.tone]))
    }
    mesh.castShadow = mesh.receiveShadow = true
    mesh.name = `furnishings-${storey.index}-${kind}`
    return [{ id: mesh.name, object: mesh, onStorey: storey.index }]
  })
}

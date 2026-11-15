import { Box3, EdgesGeometry, ExtrudeGeometry, Group, LineBasicMaterial, LineSegments, Vector3 } from 'three'
import type { BuildingModel } from '../../../server/src/model/building.ts'
import { ringBounds } from '../../../server/src/model/geo.ts'
import { protoTone } from './inferredStyle.ts'
import { buildFurnishings, type Kit } from './kit.ts'
import type { Look } from './looks.ts'
import { buildGround, buildMassing, extrudeRing, MODEL_TO_SCENE, shapeOf, toScene } from './massing.ts'
import { protoMaterial } from './protoGrid.ts'
import type { StageLayer } from './stage.ts'
import { buildStorey } from './storey.ts'

const VIEW_CONTEXT_M = 150

// The stage layers for a building opened at one storey: neighbours and ground, the storeys below
// as solid prototype massing, the cut storey with its rooms and furniture, and the storeys above
// as outlines so the height still reads. `storeyIndex: null` draws the whole building uncut.
//   stage.setLayers(buildCutaway(building, 5, look, kit))
export function buildCutaway(building: BuildingModel, storeyIndex: number | null, look: Look, kit: Kit): StageLayer[] {
  const cut = building.storeys.find(({ index }) => index === storeyIndex)
  if (!cut) return [{ id: 'massing', object: buildMassing(building, look) }]

  const context = new Group()
  for (const [i, { ring, heightM }] of building.context.entries()) context.add(Object.assign(extrudeRing(ring, 0, heightM, protoMaterial('context', look), look), { name: `context-${i}` }))
  context.add(buildGround(building, look))

  const below = new Group()
  const above = new Group()
  const outline = new LineBasicMaterial({ color: look.palette.outline })
  for (const storey of building.storeys) {
    const top = storey.elevationM + storey.heightM
    if (storey.index < cut.index) below.add(extrudeRing(storey.ring, storey.elevationM, top, protoMaterial(protoTone(storey.confidence), look), look))
    if (storey.index <= cut.index) continue
    const shape = new ExtrudeGeometry(shapeOf(storey.ring), { depth: storey.heightM, bevelEnabled: false }).translate(0, 0, storey.elevationM).applyMatrix4(MODEL_TO_SCENE)
    above.add(new LineSegments(new EdgesGeometry(shape), outline))
    shape.dispose()
  }

  return [
    { id: 'context', object: context },
    { id: 'below', object: below },
    { id: `storey-${cut.index}`, object: buildStorey(cut, look), onStorey: cut.index },
    ...buildFurnishings(cut, kit, look),
    { id: 'above', object: above },
  ]
}

// The box to frame a building in: its shell and every neighbour within 150 m, in scene
// coordinates, so a tower and a warehouse both fill the view.
//   stage.frame(viewBox(building))
export function viewBox({ shell, context }: BuildingModel) {
  const box = new Box3()
  const parts = [
    ...shell.volumes.map(({ ring, topM }) => ({ ring, topM })),
    ...context.map(({ ring, heightM }) => ({ ring, topM: heightM })).filter(({ ring }) => {
      const { minX, minY, maxX, maxY } = ringBounds(ring)
      return Math.hypot((minX + maxX) / 2, (minY + maxY) / 2) <= VIEW_CONTEXT_M
    }),
  ]
  for (const { ring, topM } of parts) {
    const { minX, minY, maxX, maxY } = ringBounds(ring)
    box.expandByPoint(toScene(minX, minY, 0)).expandByPoint(toScene(maxX, maxY, topM))
  }
  return box.isEmpty() ? new Box3(new Vector3(-10, 0, -10), new Vector3(10, 10, 10)) : box
}

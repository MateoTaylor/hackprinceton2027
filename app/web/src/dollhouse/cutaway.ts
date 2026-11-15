import { Box3, BufferGeometry, Group, LineBasicMaterial, LineLoop, Vector3 } from 'three'
import type { BuildingModel } from '../../../server/src/model/building.ts'
import { ringBounds } from '../../../server/src/model/geo.ts'
import { protoTone } from './inferredStyle.ts'
import { buildFurnishings, type Kit } from './kit.ts'
import type { Look } from './looks.ts'
import { buildGround, extrudeRing, toScene } from './massing.ts'
import { protoMaterial } from './protoGrid.ts'
import type { StageLayer } from './stage.ts'
import { buildStorey } from './storey.ts'
import { occluders } from './view.ts'

const VIEW_CONTEXT_M = 150
const FLAT_M = 0.3
const ABOVE_OPACITY = 0.25

// The neighbours and the ground. A neighbour that would hide the subject at the look's angle (see
// `occluders`) is drawn as a flat footprint instead of a block.
function buildContext(building: BuildingModel, storeyIndex: number | null, look: Look) {
  const flat = occluders(building, storeyIndex, look)
  const context = new Group()
  for (const [i, { ring, heightM }] of building.context.entries()) {
    const block = extrudeRing(ring, 0, flat.has(i) ? FLAT_M : heightM, protoMaterial('context', look), look)
    context.add(Object.assign(block, { name: flat.has(i) ? `context-${i}-flat` : `context-${i}` }))
  }
  context.add(buildGround(building, look))
  return context
}

// The stage layers for a building opened at one storey: neighbours and ground, the storeys below
// as solid prototype massing, the cut storey with its rooms and furniture, and the storeys above
// as one faint contour per floor top, so the height still reads without walls over the open floor. `storeyIndex: null` draws the whole building uncut.
//   stage.setLayers(buildCutaway(building, 5, look, kit))
export function buildCutaway(building: BuildingModel, storeyIndex: number | null, look: Look, kit: Kit): StageLayer[] {
  const context = buildContext(building, storeyIndex, look)
  const cut = building.storeys.find(({ index }) => index === storeyIndex)
  if (!cut) {
    const shell = new Group()
    for (const { id, ring, baseM, topM } of building.shell.volumes) shell.add(Object.assign(extrudeRing(ring, baseM, topM, protoMaterial('high', look), look), { name: id }))
    return [
      { id: 'context', object: context },
      { id: 'massing', object: shell },
    ]
  }

  const below = new Group()
  const above = new Group()
  const outline = new LineBasicMaterial({ color: look.palette.outline, transparent: true, opacity: ABOVE_OPACITY })
  for (const storey of building.storeys) {
    const top = storey.elevationM + storey.heightM
    if (storey.index < cut.index) below.add(extrudeRing(storey.ring, storey.elevationM, top, protoMaterial(protoTone(storey.confidence), look), look))
    if (storey.index <= cut.index) continue
    above.add(new LineLoop(new BufferGeometry().setFromPoints(storey.ring.map(([x, y]) => toScene(x, y, top))), outline))
  }

  return [
    { id: 'context', object: context },
    { id: 'below', object: below },
    { id: `storey-${cut.index}`, object: buildStorey(cut, look), onStorey: cut.index },
    ...buildFurnishings(cut, kit, look),
    { id: 'above', object: above },
  ]
}

// The neighbourhood box: the shell and every neighbour within 150 m, in scene coordinates. The
// view opens on `focusBox` and the wheel zooms out as far as this.
//   stage.frame(focusBox(building, null), viewBox(building))
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

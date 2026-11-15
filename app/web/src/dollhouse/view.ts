import { Box3, Vector3 } from 'three'
import type { BuildingModel, Point, Ring } from '../../../server/src/model/building.ts'
import { ringBounds, ringCentroid } from '../../../server/src/model/geo.ts'
import type { Look } from './looks.ts'
import { toScene } from './massing.ts'

const DEG = Math.PI / 180
const SCAN_CONTEXT = 2
const MIN_FOCUS_HALF_M = 6
const FURNISHED_M = 2
const OVERLAP_SLOP_M = 0.5

// The way the look's camera looks, in the building frame (east, north, up).
//   const [x, y, z] = viewDirection(DEFAULT_LOOK)
export function viewDirection({ azimuthDeg, elevationDeg }: Pick<Look, 'azimuthDeg' | 'elevationDeg'>) {
  const [a, e] = [azimuthDeg * DEG, elevationDeg * DEG]
  return [Math.sin(a) * Math.cos(e), Math.cos(a) * Math.cos(e), -Math.sin(e)] as const
}

type Solid = { ring: Ring; baseM: number; topM: number }

const boxOf = (solids: Solid[]) => {
  const box = new Box3()
  for (const { ring, baseM, topM } of solids) {
    const { minX, minY, maxX, maxY } = ringBounds(ring)
    box.expandByPoint(toScene(minX, minY, baseM)).expandByPoint(toScene(maxX, maxY, topM))
  }
  return box
}

// The box the view opens on, in scene coordinates. The whole building (`storeyIndex: null`) frames
// its shell and no neighbours. An open storey frames its floor plate, and when it holds scanned
// space it centres on that space with some floor around it, clipped to the floor plate.
//   stage.frame(focusBox(building, storeyIndex), viewBox(building))
export function focusBox(building: BuildingModel, storeyIndex: number | null) {
  const storey = building.storeys.find(({ index }) => index === storeyIndex)
  if (!storey) return boxOf(building.shell.volumes)
  const plate = { baseM: storey.elevationM, topM: storey.elevationM + FURNISHED_M }
  const floor = boxOf([{ ring: storey.ring, ...plate }])
  const scanned = storey.spaces.filter(({ source }) => source === 'scan')
  if (!scanned.length) return floor
  const scan = boxOf(scanned.map(({ ring }) => ({ ring, ...plate })))
  const centre = scan.getCenter(new Vector3())
  const half = scan.getSize(new Vector3()).multiplyScalar(SCAN_CONTEXT / 2).max(new Vector3(MIN_FOCUS_HALF_M, 0, MIN_FOCUS_HALF_M))
  return new Box3(centre.clone().sub(half), centre.clone().add(half)).intersect(floor)
}

// Where a solid lands on screen: its extent across and up the view, and how deep its footprint's
// centre sits along it.
function onScreen({ ring, baseM, topM }: Solid, [dx, dy, dz]: ReturnType<typeof viewDirection>) {
  const right = [dy, -dx, 0]
  const up = [right[1] * dz - right[2] * dy, right[2] * dx - right[0] * dz, right[0] * dy - right[1] * dx]
  const across = (x: number, y: number) => x * right[0] + y * right[1]
  const upward = (x: number, y: number, z: number) => x * up[0] + y * up[1] + z * up[2]
  const xs = ring.map(([x, y]) => across(x, y))
  const ys = ring.flatMap(([x, y]) => [upward(x, y, baseM), upward(x, y, topM)])
  const [cx, cy]: Point = ringCentroid(ring)
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys), depth: cx * dx + cy * dy }
}

// The indexes of the neighbours in `building.context` that stand between the camera and what the
// view is about: the shell for the whole building, else the open storey's floor and furniture. A
// neighbour counts when its footprint centre is nearer the camera and its screen extent overlaps.
// The dollhouse draws these flat, so nothing hides the subject at the one fixed angle.
//   occluders(building, 3, DEFAULT_LOOK).has(12)
export function occluders(building: BuildingModel, storeyIndex: number | null, look: Pick<Look, 'azimuthDeg' | 'elevationDeg'>) {
  const view = viewDirection(look)
  const storey = building.storeys.find(({ index }) => index === storeyIndex)
  const subjects = storey ? [{ ring: storey.ring, baseM: storey.elevationM, topM: storey.elevationM + FURNISHED_M }] : building.shell.volumes
  const shown = subjects.map((solid) => onScreen(solid, view))
  const hidden = new Set<number>()
  for (const [i, { ring, heightM }] of building.context.entries()) {
    const { minX, maxX, minY, maxY, depth } = onScreen({ ring, baseM: 0, topM: heightM }, view)
    const blocks = shown.some(
      (s) => depth < s.depth && minX < s.maxX - OVERLAP_SLOP_M && maxX > s.minX + OVERLAP_SLOP_M && minY < s.maxY - OVERLAP_SLOP_M && maxY > s.minY + OVERLAP_SLOP_M,
    )
    if (blocks) hidden.add(i)
  }
  return hidden
}

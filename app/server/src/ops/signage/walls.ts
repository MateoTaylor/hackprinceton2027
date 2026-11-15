import type { Point, Volume } from '../../model/building.ts'

const round = (value: number) => Math.round(value * 100) / 100

// One outside wall of the shell: the edge from `start` to `end` of a volume's counter-clockwise
// ring, standing from `baseM` to `topM` above the ground. `facingDeg` is the compass bearing of
// its outward face. `index` counts the edges of every volume in order, so it is stable for as long
// as the building model is.
export type Wall = {
  index: number
  volumeId: string
  start: Point
  end: Point
  baseM: number
  topM: number
  lengthM: number
  facingDeg: number
  confidence: number
}

// Every outside wall of the shell's volumes, in index order.
export function shellWalls(volumes: readonly Volume[]): Wall[] {
  return volumes.flatMap(({ id, ring, baseM, topM, confidence }) =>
    ring.map((start, i) => {
      const end = ring[(i + 1) % ring.length]
      const [dx, dy] = [end[0] - start[0], end[1] - start[1]]
      // A counter-clockwise ring has the outside on its right, along (dy, -dx).
      const facingDeg = round((((Math.atan2(dy, -dx) * 180) / Math.PI) + 360) % 360) % 360
      return { volumeId: id, start, end, baseM, topM, lengthM: round(Math.hypot(dx, dy)), facingDeg, confidence }
    }),
  ).map((wall, index) => ({ index, ...wall }))
}

// The difference between two bearings in degrees, from 0 to 180.
export const bearingGap = (a: number, b: number) => Math.abs((((a - b) % 360) + 540) % 360 - 180)

// The longest wall that faces within 45 degrees of `facingDeg` and is at least `widthM` long and
// `heightM` tall, or undefined when none is.
export function wallFacing(walls: readonly Wall[], facingDeg: number, { widthM, heightM }: { widthM: number; heightM: number }) {
  return walls
    .filter((wall) => bearingGap(wall.facingDeg, facingDeg) <= 45 && wall.lengthM >= widthM && wall.topM - wall.baseM >= heightM)
    .reduce<Wall | undefined>((best, wall) => (!best || wall.lengthM > best.lengthM ? wall : best), undefined)
}

// A sign's place on a wall: its centre `alongM` from the wall's start corner, its bottom edge
// `bottomM` above the ground, and its face size.
export type Placement = { alongM: number; bottomM: number; sizeM: { widthM: number; heightM: number } }

// Why a placement does not fit on its wall, as a sentence with the range that would, or null when
// it fits. Edges may overhang by 5 cm, the rounding of a click.
export function misfit(wall: Wall, { alongM, bottomM, sizeM: { widthM, heightM } }: Placement) {
  const slack = 0.05
  if (widthM > wall.lengthM + slack) return `Wall ${wall.index} is ${wall.lengthM} m long, too short for a ${widthM} m sign.`
  if (heightM > wall.topM - wall.baseM + slack) return `Wall ${wall.index} is ${round(wall.topM - wall.baseM)} m tall, too short for a ${heightM} m sign.`
  if (alongM - widthM / 2 < -slack || alongM + widthM / 2 > wall.lengthM + slack) {
    return `On wall ${wall.index}, alongM must be from ${round(widthM / 2)} to ${round(wall.lengthM - widthM / 2)} for this width.`
  }
  if (bottomM < wall.baseM - slack || bottomM + heightM > wall.topM + slack) {
    return `On wall ${wall.index}, bottomM must be from ${wall.baseM} to ${round(wall.topM - heightM)} for this height.`
  }
  return null
}

// The four corners of a placed sign in the building frame, counter-clockwise as seen from outside
// starting at the bottom left.
export function signCorners(wall: Wall, { alongM, bottomM, sizeM: { widthM, heightM } }: Placement): [number, number, number][] {
  const [ux, uy] = [(wall.end[0] - wall.start[0]) / wall.lengthM, (wall.end[1] - wall.start[1]) / wall.lengthM]
  const at = (offset: number, z: number): [number, number, number] => [wall.start[0] + ux * offset, wall.start[1] + uy * offset, z]
  const [left, right, top] = [alongM - widthM / 2, alongM + widthM / 2, bottomM + heightM]
  return [at(left, bottomM), at(right, bottomM), at(right, top), at(left, top)]
}

export type Vec3 = [number, number, number]

// A sign as scene_get returns it: `position` is the centre of its back face, in metres with Y up,
// and `yawDeg` turns its face away from the wall.
export type PlacedSign = {
  id: string
  position: Vec3
  yawDeg: number
  sizeM: { widthM: number; heightM: number }
  groundY?: number
}

export type Measure = { kind: 'width' | 'height' | 'clearance'; from: Vec3; to: Vec3; lengthM: number }

export const SIGN_DEPTH_M = 0.05
const LINE_GAP_M = 0.15
const PROBE_REACH_M = [0.3, 1, 2]

// What a surface is from its unit normal: within 30° of level is a floor or ceiling, within 20° of
// upright is a wall, and a slope in between is nothing a sign or a lift can use.
export function classifyNormal([, y]: Vec3) {
  if (y >= 0.866) return 'floor'
  if (y <= -0.866) return 'ceiling'
  return Math.abs(y) <= 0.342 ? 'wall' : null
}

// The level direction a sign faces, away from its wall.
export function facing({ yawDeg }: Pick<PlacedSign, 'yawDeg'>): Vec3 {
  const yaw = (yawDeg * Math.PI) / 180
  return [Math.cos(yaw), 0, -Math.sin(yaw)]
}

// Points level with the sign's bottom edge, stepping out from the wall. The ground is whatever
// lies straight below the first one that is over a floor.
export function groundProbes(sign: PlacedSign): Vec3[] {
  const [x, y, z] = sign.position
  const [nx, , nz] = facing(sign)
  return PROBE_REACH_M.map((reach) => [x + nx * reach, y - sign.sizeM.heightM / 2, z + nz * reach])
}

// The lines to draw for a sign: its width above the top edge, its height beside one side and,
// when the ground is measured, the gap from the ground to the bottom edge. Every line floats just
// in front of the sign's face.
export function signMeasures(sign: PlacedSign): Measure[] {
  const { widthM, heightM } = sign.sizeM
  const [nx, , nz] = facing(sign)
  const out = SIGN_DEPTH_M + 0.02
  const at = (along: number, up: number): Vec3 => [
    sign.position[0] + nx * out - nz * along,
    sign.position[1] + up,
    sign.position[2] + nz * out + nx * along,
  ]
  const top = heightM / 2 + LINE_GAP_M
  const side = widthM / 2 + LINE_GAP_M
  const measures: Measure[] = [
    { kind: 'width', from: at(-widthM / 2, top), to: at(widthM / 2, top), lengthM: widthM },
    { kind: 'height', from: at(side, -heightM / 2), to: at(side, heightM / 2), lengthM: heightM },
  ]
  if (sign.groundY === undefined) return measures
  const clearance = sign.position[1] - heightM / 2 - sign.groundY
  if (clearance < -0.05) return measures
  return [...measures, { kind: 'clearance', from: at(0, sign.groundY - sign.position[1]), to: at(0, -heightM / 2), lengthM: Math.max(0, clearance) }]
}

// A length for a label: `2.40 m · 7 ft 10 in`.
export function formatLength(metres: number) {
  const inches = Math.round(metres / 0.0254)
  return `${metres.toFixed(2)} m · ${Math.floor(inches / 12)} ft ${inches % 12} in`
}

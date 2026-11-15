// The maths of hanging a sign on a building seen in an oblique photo. Everything is in the
// building's frame from signage_get and signage_camera: metres, x east, y north, z up. `Camera` is
// the 3x4 projection, row-major, to photo pixels.

export type Vec2 = [number, number]
export type Vec3 = [number, number, number]
export type Camera = { matrix: number[]; centreM: Vec3 }
export type Wall = { index: number; volumeId: string; start: Vec2; end: Vec2; lengthM: number; facingDeg: number; baseM: number; topM: number }
export type Placement = { alongM: number; bottomM: number; sizeM: { widthM: number; heightM: number } }

// Where a click meets a wall: `alongM` from its start corner and `heightM` above the ground.
export type WallHit = { wall: Wall; alongM: number; heightM: number }

// The pixel where the camera sees a point, or null behind it.
export function project({ matrix: m }: Pick<Camera, 'matrix'>, [x, y, z]: Vec3): Vec2 | null {
  const w = m[8] * x + m[9] * y + m[10] * z + m[11]
  if (!(w > 0)) return null
  return [(m[0] * x + m[1] * y + m[2] * z + m[3]) / w, (m[4] * x + m[5] * y + m[6] * z + m[7]) / w]
}

const direction = ({ start, end, lengthM }: Wall): Vec2 => [(end[0] - start[0]) / lengthM, (end[1] - start[1]) / lengthM]

// The point `alongM` from a wall's start corner at `heightM` above the ground.
export function onWall(wall: Wall, alongM: number, heightM: number): Vec3 {
  const [ux, uy] = direction(wall)
  return [wall.start[0] + ux * alongM, wall.start[1] + uy * alongM, heightM]
}

// Whether the camera sees a wall's outside face rather than its back.
export function facesCamera(wall: Wall, { centreM }: Pick<Camera, 'centreM'>) {
  const [ux, uy] = direction(wall)
  return uy * (centreM[0] - wall.start[0]) - ux * (centreM[1] - wall.start[1]) > 0
}

// The four corners of a sign, bottom left first and counter-clockwise as seen from outside.
export function signCorners(wall: Wall, { alongM, bottomM, sizeM: { widthM, heightM } }: Placement): Vec3[] {
  const [left, right, top] = [alongM - widthM / 2, alongM + widthM / 2, bottomM + heightM]
  return [onWall(wall, left, bottomM), onWall(wall, right, bottomM), onWall(wall, right, top), onWall(wall, left, top)]
}

// The plane coordinates [a, b] and the depth where the ray through `pixel` meets the plane with
// origin `o` and axes `ea` and `eb`, or null when it misses or meets it behind the camera.
function onPlane({ matrix: m }: Pick<Camera, 'matrix'>, o: Vec3, ea: Vec3, eb: Vec3, [u, v]: Vec2) {
  const row = (r: number, [x, y, z]: Vec3, w: number) => m[r * 4] * x + m[r * 4 + 1] * y + m[r * 4 + 2] * z + m[r * 4 + 3] * w
  // The plane-to-pixel homography has columns P·ea, P·eb and P·o.
  const h = [0, 1, 2].map((r) => [row(r, ea, 0), row(r, eb, 0), row(r, o, 1)])
  // Each pixel equation u·h2 - h0 = 0 and v·h2 - h1 = 0 is linear in [a, b, 1].
  const [a1, b1, c1] = [0, 1, 2].map((j) => u * h[2][j] - h[0][j])
  const [a2, b2, c2] = [0, 1, 2].map((j) => v * h[2][j] - h[1][j])
  const det = a1 * b2 - a2 * b1
  if (Math.abs(det) < 1e-12) return null
  const a = (b1 * c2 - b2 * c1) / det
  const b = (a2 * c1 - a1 * c2) / det
  const depth = h[2][0] * a + h[2][1] * b + h[2][2]
  return depth > 0 ? { a, b, depth } : null
}

// Where the ray through `pixel` meets a wall's plane, inside the wall or not.
export function wallPlaneAt(camera: Pick<Camera, 'matrix'>, wall: Wall, pixel: Vec2) {
  const [ux, uy] = direction(wall)
  const hit = onPlane(camera, [wall.start[0], wall.start[1], 0], [ux, uy, 0], [0, 0, 1], pixel)
  return hit && { alongM: hit.a, heightM: hit.b, depth: hit.depth }
}

function insideRing([x, y]: Vec2, ring: readonly Vec2[]) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

// The nearest wall face the ray through `pixel` meets, or null when it meets a roof first or
// misses the building. Only walls facing the camera count, and each volume's roof hides what is
// behind it.
export function hitWall(camera: Camera, walls: readonly Wall[], pixel: Vec2): WallHit | null {
  let best: (WallHit & { depth: number }) | null = null
  for (const wall of walls) {
    if (!facesCamera(wall, camera)) continue
    const hit = wallPlaneAt(camera, wall, pixel)
    if (!hit || hit.alongM < 0 || hit.alongM > wall.lengthM || hit.heightM < wall.baseM || hit.heightM > wall.topM) continue
    if (!best || hit.depth < best.depth) best = { wall, ...hit }
  }
  for (const { ring, topM } of volumes(walls)) {
    const roof = onPlane(camera, [0, 0, topM], [1, 0, 0], [0, 1, 0], pixel)
    if (roof && (!best || roof.depth < best.depth) && insideRing([roof.a, roof.b], ring)) return null
  }
  return best && { wall: best.wall, alongM: best.alongM, heightM: best.heightM }
}

// The outline and top of each volume, rebuilt from its walls in order.
export function volumes(walls: readonly Wall[]) {
  const byVolume = new Map<string, { ring: Vec2[]; baseM: number; topM: number }>()
  for (const { volumeId, start, baseM, topM } of walls) {
    const volume = byVolume.get(volumeId) ?? { ring: [], baseM, topM }
    volume.ring.push(start)
    byVolume.set(volumeId, volume)
  }
  return [...byVolume.values()]
}

const round = (value: number) => Math.round(value * 100) / 100

// The placement moved as little as possible to fit inside its wall, rounded to centimetres. A sign
// larger than its wall is shrunk to the wall.
export function fitOnWall(wall: Wall, { alongM, bottomM, sizeM }: Placement): Placement {
  const widthM = Math.min(sizeM.widthM, wall.lengthM)
  const heightM = Math.min(sizeM.heightM, wall.topM - wall.baseM)
  const clamp = (value: number, low: number, high: number) => round(Math.min(Math.max(value, low), high))
  return {
    alongM: clamp(alongM, widthM / 2, wall.lengthM - widthM / 2),
    bottomM: clamp(bottomM, wall.baseM, wall.topM - heightM),
    sizeM: { widthM: round(widthM), heightM: round(heightM) },
  }
}

// The smallest side a sign may have, as the server's SizeM allows.
export const MIN_SIDE_M = 0.2

// Why a sign of `sizeM` cannot hang on `wall`, in words for the user, or null when it fits. The
// wall's own width and height are the only upper bounds.
export function sizeProblem(wall: Wall, { widthM, heightM }: Placement['sizeM']) {
  const tallM = round(wall.topM - wall.baseM)
  if (widthM > wall.lengthM) return `This wall is ${wall.lengthM} m wide. Place the sign on a wider wall for more.`
  if (heightM > tallM) return `This wall is ${tallM} m tall.`
  if (widthM < MIN_SIDE_M || heightM < MIN_SIDE_M) return `A sign is at least ${MIN_SIDE_M} m on each side.`
  return null
}

// The criss-cross hatch on a sign's face: two families of lines at 45 degrees, `spacingM` apart
// on the wall, clipped to the sign. Lines stay lines in the photo, so projecting each end draws
// the hatch in the sign's own perspective.
export function hatch(wall: Wall, { alongM, bottomM, sizeM: { widthM: w, heightM: h } }: Placement, spacingM: number): [Vec3, Vec3][] {
  const left = alongM - w / 2
  const at = (u: number, v: number) => onWall(wall, left + u, bottomM + v)
  const lines: [Vec3, Vec3][] = []
  // Rising lines v = u + c and falling lines v = c - u, for c on the spacing grid inside the sign.
  for (let c = Math.ceil(-w / spacingM) * spacingM; c < h; c += spacingM) {
    const [u0, u1] = [Math.max(0, -c), Math.min(w, h - c)]
    if (u1 > u0) lines.push([at(u0, u0 + c), at(u1, u1 + c)])
  }
  for (let c = spacingM; c < w + h; c += spacingM) {
    const [u0, u1] = [Math.max(0, c - h), Math.min(w, c)]
    if (u1 > u0) lines.push([at(u0, c - u0), at(u1, c - u1)])
  }
  return lines
}

// A length in metres with feet and inches beside it.
export function formatLength(metres: number) {
  const inches = Math.round(metres / 0.0254)
  return `${metres.toFixed(2)} m · ${Math.floor(inches / 12)} ft ${inches % 12} in`
}

import type { ObliqueCamera } from '../../obliquePose.ts'
import { homographyMatrix } from '../../obliquePose.ts'
import { toEnu } from '../../model/geo.ts'
import type { Origin, Point } from '../../model/building.ts'

type Vec3 = [number, number, number]

// An oblique photo's camera in a building's frame: x east, y north and z up, in metres from the
// building's origin at its ground. `matrix` is the 3x4 projection, row-major, that takes [x, y, z, 1]
// to homogeneous pixels of the extract, measured from its top left. `centreM` is where the camera
// stood. `groundFromPhoto` is true when the building's ground height was unknown and the photo's
// ground stood in for it.
export type FrameCamera = { widthPx: number; heightPx: number; matrix: number[]; centreM: Vec3; groundFromPhoto: boolean }

const mulMat = (a: number[][], b: number[][]) => a.map((row) => b[0].map((_, j) => row.reduce((sum, value, k) => sum + value * b[k][j], 0)))

// Builds the camera of one oblique photo in the frame of `origin`. Vexcel gives the frame's ground
// outline at `groundZ`, which fixes a homography from that ground plane to the photo, and the
// camera's measured position. Vexcel drew the outline through that position, so a central
// projection from it onto the plane, then the homography, maps any point to its pixel. Returns null
// when the outline is degenerate.
//
// The building shell writes a ground height of 0 when Vexcel gave no roof elevation, and no Houston
// or Los Angeles base sits at exactly 0 m, so 0 means unknown. Then the photo's ground height
// (`groundZ`) becomes the frame's ground, which keeps the camera's measured height above the
// ground instead of above sea level.
export function cameraInFrame(camera: ObliqueCamera, measured: Origin): FrameCamera | null {
  const { frame, crop } = camera
  const groundFromPhoto = measured.groundElevationM === 0
  const origin = groundFromPhoto ? { ...measured, groundElevationM: camera.groundZ } : measured
  const planeZ = camera.groundZ - origin.groundElevationM
  const ground = camera.footprint.map((corner) => toEnu(origin, corner))
  const [cx, cy] = [ground.reduce((s, p) => s + p[0], 0) / 4, ground.reduce((s, p) => s + p[1], 0) / 4]
  const scale = Math.max(...ground.map(([x, y]) => Math.hypot(x - cx, y - cy)))
  // Both sides near unit size keep the 8x8 solve well conditioned.
  const unitGround = ground.map(([x, y]): Point => [(x - cx) / scale, (y - cy) / scale])
  const unitPixels: Point[] = [[0, 0], [1, 0], [1, frame.height / frame.width], [0, frame.height / frame.width]]
  const h = homographyMatrix(unitGround, unitPixels)
  if (!h) return null
  const toCrop = [[frame.width, 0, -crop.x], [0, frame.width, -crop.y], [0, 0, 1]]
  const fromGround = [[1 / scale, 0, -cx / scale], [0, 1 / scale, -cy / scale], [0, 0, 1]]
  const H = mulMat(mulMat(toCrop, [h.slice(0, 3), h.slice(3, 6), h.slice(6, 9)]), fromGround)

  const [ex, ey] = toEnu(origin, camera.cameraAt)
  const centreM: Vec3 = [ex, ey, camera.cameraZ - origin.groundElevationM]
  const rise = centreM[2] - planeZ
  // A point Q is seen where the line from the camera through Q meets the plane: in homogeneous
  // plane coordinates [(Cz - z0) Qx + (z0 - Qz) Cx, (Cz - z0) Qy + (z0 - Qz) Cy, Cz - Qz].
  const toPlane = [
    [rise, 0, -ex, planeZ * ex],
    [0, rise, -ey, planeZ * ey],
    [0, 0, -1, centreM[2]],
  ]
  const P = mulMat(H, toPlane)
  // Keep the camera in front: the depth row must be positive at the plane's centre.
  const sign = Math.sign(P[2][0] * cx + P[2][1] * cy + P[2][2] * planeZ + P[2][3]) || 1
  const norm = sign * Math.hypot(...P[2])
  const matrix = P.flat().map((value) => value / norm)
  return matrix.every(Number.isFinite) ? { widthPx: crop.width, heightPx: crop.height, matrix, centreM, groundFromPhoto } : null
}

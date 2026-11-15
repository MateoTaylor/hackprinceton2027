import type { LngLat, ObliquePose } from '../../shared/api.ts'

// Vexcel writes the XMP packet near the start of every oriented extract.
const XMP_WINDOW = 65_536
const M_PER_DEG = 111_320

type Point = [number, number]

// Reads where an oriented extract lies on the ground and where its camera stood, from the Vexcel
// XMP inside the JPEG. `geometry` is the whole frame's ground footprint with corners in frame order
// and `pixel-bbox` is the crop inside that frame, so one homography from frame to ground gives the
// crop's quad, and its local stretch at the focus gives the camera's bearing and pitch. `focus` is
// the ground polygon the client frames at rest, and `pin` the point it puts in the middle: the focus
// box grows evenly around the pin to take in the polygon, so the camera can aim at the pin before
// the photo arrives and never has to slide. A pin off the photo leaves the box on the polygon. The
// extract must be full resolution: a `downsample` step halves `pixel-bbox` but not `raster-size`.
// Returns null when any field is missing or malformed, or the focus misses the photo.
export function readObliquePose(jpeg: Uint8Array, focus: LngLat[], pin: LngLat): ObliquePose | null {
  const head = new TextDecoder('latin1').decode(jpeg.subarray(0, XMP_WINDOW))
  const field = (name: string) => head.match(new RegExp(`<Vexcel:${name}>([^<]*)</Vexcel:${name}>`))?.[1]
  const numbers = (text = '') => text.match(/-?\d+(?:\.\d+)?(?:E-?\d+)?/gi)?.map(Number) ?? []

  const [frameW, frameH] = [Number(field('raster-size-width')), Number(field('raster-size-height'))]
  const [cropX, cropY, cropW, cropH] = numbers(field('pixel-bbox'))
  const ring = numbers(field('geometry'))
  const capturedOn = field('capture-date')?.match(/^\d{4}-\d{2}-\d{2}/)?.[0]
  if (!capturedOn || ring.length < 8 || ![frameW, frameH, cropX, cropY, cropW, cropH, ...ring].every(Number.isFinite)) return null

  const footprint = [0, 1, 2, 3].map((i): LngLat => [ring[i * 2], ring[i * 2 + 1]])
  const [lon0, lat0] = footprint[0]
  const lonScale = M_PER_DEG * Math.cos((lat0 * Math.PI) / 180)
  const toMetres = ([lon, lat]: LngLat): Point => [(lon - lon0) * lonScale, (lat - lat0) * M_PER_DEG]
  const toLngLat = ([e, n]: Point): LngLat => [lon0 + e / lonScale, lat0 + n / M_PER_DEG]

  // A unit square keeps the 8x8 system well conditioned.
  const unit: Point[] = [[0, 0], [1, 0], [1, 1], [0, 1]]
  const toGround = homography(unit, footprint.map(toMetres))
  const fromGround = homography(footprint.map(toMetres), unit)
  if (!toGround || !fromGround) return null
  const ground = ([x, y]: Point) => toGround([x / frameW, y / frameH])
  const pixel = (p: LngLat): Point => {
    const [u, v] = fromGround(toMetres(p))
    return [u * frameW - cropX, v * frameH - cropY]
  }

  const seen = focus.map(pixel)
  const clampTo = (max: number, values: number[]) => [Math.max(0, Math.min(...values)), Math.min(max, Math.max(...values))]
  const [left, right] = clampTo(cropW, seen.map((p) => p[0]))
  const [top, bottom] = clampTo(cropH, seen.map((p) => p[1]))
  if (!(right > left && bottom > top)) return null
  const [px, py] = pixel(pin)
  const around = (at: number, low: number, high: number, max: number) => {
    const half = Math.min(Math.max(at - low, high - at), at, max - at)
    return [at - half, at + half]
  }
  const pinned = px > 0 && px < cropW && py > 0 && py < cropH
  const [boxLeft, boxRight] = pinned ? around(px, left, right, cropW) : [left, right]
  const [boxTop, boxBottom] = pinned ? around(py, top, bottom, cropH) : [top, bottom]

  const corners: Point[] = [[cropX, cropY], [cropX + cropW, cropY], [cropX + cropW, cropY + cropH], [cropX, cropY + cropH]]
  const [cx, cy] = [cropX + (boxLeft + boxRight) / 2, cropY + (boxTop + boxBottom) / 2]
  const g0 = ground([cx, cy])
  const gx = ground([cx + 1, cy])
  const gy = ground([cx, cy + 1])
  const across = Math.hypot(gx[0] - g0[0], gx[1] - g0[1])
  const along = Math.hypot(gy[0] - g0[0], gy[1] - g0[1])
  const [tl, tr, br, bl] = corners.map((p) => toLngLat(ground(p)))
  const pose = {
    width: cropW,
    height: cropH,
    quad: [tl, tr, br, bl] satisfies ObliquePose['quad'],
    focus: { center: toLngLat(g0), x: boxLeft, y: boxTop, width: boxRight - boxLeft, height: boxBottom - boxTop },
    bearing: (Math.atan2(g0[0] - gy[0], g0[1] - gy[1]) * 180) / Math.PI,
    // A ground patch seen at tilt t is foreshortened along the view by cos t.
    pitch: (Math.acos(Math.min(1, across / along)) * 180) / Math.PI,
    metresPerPixel: across,
    capturedOn,
  }
  return [pose.bearing, pose.pitch, pose.metresPerPixel, ...pose.quad.flat(), ...pose.focus.center].every(Number.isFinite) ? pose : null
}

// The projective map that sends each `from` point to the matching `to` point, or null when the
// points are degenerate.
function homography(from: Point[], to: Point[]) {
  const rows = from.flatMap(([x, y], i) => {
    const [u, v] = to[i]
    return [
      [x, y, 1, 0, 0, 0, -u * x, -u * y, u],
      [0, 0, 0, x, y, 1, -v * x, -v * y, v],
    ]
  })
  const h = solve(rows)
  if (!h) return null
  return ([x, y]: Point): Point => {
    const w = h[6] * x + h[7] * y + 1
    return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w]
  }
}

// Gauss-Jordan elimination with partial pivoting on an augmented n x (n+1) matrix.
function solve(m: number[][]) {
  const n = m.length
  for (let col = 0; col < n; col++) {
    let pivot = col
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r
    if (Math.abs(m[pivot][col]) < 1e-12) return null
    ;[m[col], m[pivot]] = [m[pivot], m[col]]
    for (let r = 0; r < n; r++) {
      if (r === col) continue
      const f = m[r][col] / m[col][col]
      for (let c = col; c <= n; c++) m[r][c] -= f * m[col][c]
    }
  }
  return m.map((row, i) => row[n] / row[i])
}

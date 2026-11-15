import type { LngLat, ObliquePose } from '../../shared/api.ts'

// Vexcel writes the XMP packet near the start of every oriented extract.
const XMP_WINDOW = 65_536
const M_PER_DEG = 111_320

type Point = [number, number]

// The camera facts in an oriented extract's XMP that a projection needs. `footprint` is the whole
// frame's ground outline at `groundZ`, corners in frame order from the top left. `crop` is the
// extract inside that frame in pixels. `cameraAt` is where the camera stood, from Vexcel's measured
// `camera-pos-x` and `camera-pos-y` in UTM, and `cameraZ` its height. Heights are metres above sea
// level. Returns null when any field is missing or malformed.
export function readObliqueCamera(jpeg: Uint8Array) {
  const head = new TextDecoder('latin1').decode(jpeg.subarray(0, XMP_WINDOW))
  const field = (name: string) => head.match(new RegExp(`<Vexcel:${name}>([^<]*)</Vexcel:${name}>`))?.[1]
  const numbers = (text = '') => text.match(/-?\d+(?:\.\d+)?(?:E-?\d+)?/gi)?.map(Number) ?? []
  const [frameW, frameH, groundZ, cameraX, cameraY, cameraZ] = ['raster-size-width', 'raster-size-height', 'ground-z', 'camera-pos-x', 'camera-pos-y', 'camera-pos-z'].map((name) => Number(field(name)))
  const zone = field('utm-zone')?.match(/^(\d{1,2})([NS])$/i)
  const [x, y, width, height] = numbers(field('pixel-bbox'))
  const ring = numbers(field('geometry'))
  const values = [frameW, frameH, groundZ, cameraX, cameraY, cameraZ, x, y, width, height, ...ring]
  if (!zone || ring.length < 8 || !values.every(Number.isFinite) || !(cameraZ > groundZ)) return null
  return {
    frame: { width: frameW, height: frameH },
    crop: { x, y, width, height },
    footprint: [0, 1, 2, 3].map((i): LngLat => [ring[i * 2], ring[i * 2 + 1]]),
    groundZ,
    cameraAt: utmToLngLat(cameraX, cameraY, Number(zone[1]), zone[2].toUpperCase() === 'N'),
    cameraZ,
  }
}

// A WGS84 UTM easting and northing as a GeoJSON position, by the standard series inverse, which is
// good to well under a centimetre inside a zone.
export function utmToLngLat(easting: number, northing: number, zone: number, north: boolean): LngLat {
  const [a, f, k0] = [6_378_137, 1 / 298.257223563, 0.9996]
  const e2 = f * (2 - f)
  const ep2 = e2 / (1 - e2)
  const x = easting - 500_000
  const mu = (north ? northing : northing - 10_000_000) / k0 / (a * (1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256))
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2))
  const phi1 =
    mu +
    ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) +
    ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu)
  const [sin, cos, tan] = [Math.sin(phi1), Math.cos(phi1), Math.tan(phi1)]
  const c1 = ep2 * cos ** 2
  const t1 = tan ** 2
  const n1 = a / Math.sqrt(1 - e2 * sin ** 2)
  const r1 = (a * (1 - e2)) / (1 - e2 * sin ** 2) ** 1.5
  const d = x / (n1 * k0)
  const lat =
    phi1 -
    ((n1 * tan) / r1) *
      (d ** 2 / 2 - ((5 + 3 * t1 + 10 * c1 - 4 * c1 ** 2 - 9 * ep2) * d ** 4) / 24 + ((61 + 90 * t1 + 298 * c1 + 45 * t1 ** 2 - 252 * ep2 - 3 * c1 ** 2) * d ** 6) / 720)
  const lon = (d - ((1 + 2 * t1 + c1) * d ** 3) / 6 + ((5 - 2 * c1 + 28 * t1 - 3 * c1 ** 2 + 8 * ep2 + 24 * t1 ** 2) * d ** 5) / 120) / cos
  return [zone * 6 - 183 + (lon * 180) / Math.PI, (lat * 180) / Math.PI]
}
export type ObliqueCamera = NonNullable<ReturnType<typeof readObliqueCamera>>

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

// The 3x3 projective matrix, row-major, that sends each of four `from` points to the matching `to`
// point, or null when the points are degenerate.
export function homographyMatrix(from: Point[], to: Point[]) {
  const rows = from.flatMap(([x, y], i) => {
    const [u, v] = to[i]
    return [
      [x, y, 1, 0, 0, 0, -u * x, -u * y, u],
      [0, 0, 0, x, y, 1, -v * x, -v * y, v],
    ]
  })
  const h = solve(rows)
  return h && [...h, 1]
}

// The same map as a function on points.
function homography(from: Point[], to: Point[]) {
  const h = homographyMatrix(from, to)
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

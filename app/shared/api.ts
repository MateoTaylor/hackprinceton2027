// HTTP shapes of the Propstar server (app/server) that the web client consumes.
// Import it with `import type` and a relative path; this file has no runtime code.

export type Direction = 'north' | 'east' | 'south' | 'west'

// GET /api/oblique/:id. Directions come from the newest Vexcel oblique collection over the parcel,
// in north, east, south, west order. Empty when Vexcel has no obliques there.
export interface ObliqueIndex {
  directions: Direction[]
}

export type LngLat = [lon: number, lat: number]

// JSON in the `X-Oblique-Pose` header of GET /api/oblique/:id/:dir, read from the photo's own XMP.
// It says where the photo lies on the ground and where its camera stood, so the client can drape the
// photo on the map and look at it from the aircraft's pose. The header is absent when the XMP is
// unreadable.
export interface ObliquePose {
  width: number
  height: number
  // Ground under the photo's corners: top left, top right, bottom right, bottom left.
  quad: [LngLat, LngLat, LngLat, LngLat]
  // The property's box in photo pixels from the top left, and the ground under the box's centre. The
  // photo reaches well past it so it can fill the map while the box fills the free part of it.
  focus: { center: LngLat; x: number; y: number; width: number; height: number }
  // Camera heading in degrees clockwise from north, and tilt in degrees off vertical.
  bearing: number
  pitch: number
  metresPerPixel: number
  // Day the photo was taken, YYYY-MM-DD.
  capturedOn: string
}

// Body of every JSON error: 400 for a malformed parameter, 404 for an unknown property or missing
// imagery, 502 or 503 when Vexcel fails.
export interface ApiError {
  error: string
}

// GET /api/renders/:modelId. Mateo's prepared scan edits for a Matterport model, keyed by the
// sweep (panorama) id the edit was seen from. Each slide is one flat square view taken from that
// sweep: its pictures before and after the edit and the mask of what changed (white), as URLs on
// this API, and where it looked. `yaw` (from +X towards +Y), `pitch` (up from level) and `fov`
// (horizontal) are degrees in the scan's Z-up world frame. Empty `sweeps` when the model has none.
export interface RenderSlides {
  sweeps: Record<string, RenderSlide[]>
}

export interface RenderSlide {
  command: string
  before: string
  after: string
  mask: string
  view: { yaw: number; pitch: number; fov: number; width: number; height: number }
}

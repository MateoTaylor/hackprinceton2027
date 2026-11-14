// HTTP shapes of the Propstar server (app/server) that the web client consumes.
// Import it with `import type` and a relative path; this file has no runtime code.

export type Direction = 'north' | 'east' | 'south' | 'west'

// GET /api/oblique/:id. Directions come from the newest Vexcel oblique collection over the parcel,
// in north, east, south, west order. Empty when Vexcel has no obliques there.
export interface ObliqueIndex {
  directions: Direction[]
}

// Body of every JSON error: 400 for a malformed parameter, 404 for an unknown property or missing
// imagery, 502 or 503 when Vexcel fails.
export interface ApiError {
  error: string
}

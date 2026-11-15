// Every kind of furnishing a space can hold.
export const FURNISHING_KINDS = [
  'desk',
  'chair',
  'table',
  'conference_table',
  'sofa',
  'bed',
  'shelf',
  'counter',
  'toilet',
  'sink',
  'plant',
  'rack',
  'pallet',
  'crate',
  'machine',
] as const

export type FurnishingKind = (typeof FURNISHING_KINDS)[number]

// The box a furnishing fills, centred on its `at`. At `yawDeg` 0 the width runs east and the depth
// runs north; a positive yaw turns the box counter-clockwise.
export interface Footprint {
  widthM: number
  depthM: number
  heightM: number
}

// The invented size of each kind.
//   const { widthM, depthM } = FURNISHING_FOOTPRINTS[furnishing.kind]
export const FURNISHING_FOOTPRINTS = {
  desk: { widthM: 1.5, depthM: 0.75, heightM: 0.75 },
  chair: { widthM: 0.55, depthM: 0.55, heightM: 0.9 },
  table: { widthM: 1.2, depthM: 0.8, heightM: 0.75 },
  conference_table: { widthM: 3.6, depthM: 1.2, heightM: 0.75 },
  sofa: { widthM: 2.0, depthM: 0.9, heightM: 0.8 },
  bed: { widthM: 1.6, depthM: 2.0, heightM: 0.55 },
  shelf: { widthM: 1.0, depthM: 0.35, heightM: 1.9 },
  counter: { widthM: 2.4, depthM: 0.6, heightM: 0.9 },
  toilet: { widthM: 0.4, depthM: 0.7, heightM: 0.8 },
  sink: { widthM: 0.6, depthM: 0.5, heightM: 0.85 },
  plant: { widthM: 0.5, depthM: 0.5, heightM: 1.4 },
  rack: { widthM: 2.7, depthM: 1.1, heightM: 5.5 },
  pallet: { widthM: 1.2, depthM: 1.0, heightM: 1.3 },
  crate: { widthM: 0.8, depthM: 0.6, heightM: 0.6 },
  machine: { widthM: 2.2, depthM: 1.4, heightM: 1.8 },
} satisfies Record<FurnishingKind, Footprint>

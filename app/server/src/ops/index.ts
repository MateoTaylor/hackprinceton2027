import { AREA_OPS } from './area/index.ts'
import { BUILDING_OPS } from './building/index.ts'
import { EDIT_OPS } from './edit/index.ts'
import { EQUIPMENT_OPS } from './equipment/index.ts'
import { FEATURES_OPS } from './features/index.ts'
import type { Op } from './op.ts'
import { PROPERTY_OPS } from './property/index.ts'
import { ROUTE_OPS } from './route/index.ts'
import { SCENE_OPS } from './scene/index.ts'
import { SEARCH_OPS } from './search/index.ts'
import { SIGNAGE_OPS } from './signage/index.ts'

// The public ops, served at /api/ops.
export const OPS: Op[] = [
  ...PROPERTY_OPS,
  ...SEARCH_OPS,
  ...BUILDING_OPS,
  ...ROUTE_OPS,
  ...FEATURES_OPS,
  ...EQUIPMENT_OPS,
  ...SIGNAGE_OPS,
  ...SCENE_OPS,
  ...EDIT_OPS,
]

// Proppy's private ops, served at /api/proppy/ops: what is around a property, from open map data.
// They never appear in the public list.
export const PROPPY_OPS: Op[] = [...AREA_OPS]

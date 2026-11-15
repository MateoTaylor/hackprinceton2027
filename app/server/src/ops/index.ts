import { AREA_OPS } from './area/index.ts'
import { BUILDING_OPS } from './building/index.ts'
import { EDIT_OPS } from './edit/index.ts'
import { EQUIPMENT_OPS } from './equipment/index.ts'
import { FEATURES_OPS } from './features/index.ts'
import type { Op } from './op.ts'
import { PROPERTY_OPS } from './property/index.ts'
import { ROUTE_OPS } from './route/index.ts'
import { SCENE_OPS } from './scene/index.ts'
import { SIGNAGE_OPS } from './signage/index.ts'

export const OPS: Op[] = [
  ...PROPERTY_OPS,
  ...BUILDING_OPS,
  ...ROUTE_OPS,
  ...AREA_OPS,
  ...FEATURES_OPS,
  ...EQUIPMENT_OPS,
  ...SIGNAGE_OPS,
  ...SCENE_OPS,
  ...EDIT_OPS,
]

import type { Op } from './op.ts'
import { PROPERTY_OPS } from './property/index.ts'

export const OPS: Op[] = [...PROPERTY_OPS]

import { z } from 'zod'
import type { Bounds, Camera, Highlight, Screen, ToolId, View, ViewFilter, ViewReport } from '../../../shared/view.ts'

export const HIGHLIGHTS_MAX = 200

export const ToolIdSchema = z.enum(['dollhouse', 'route', 'signage', 'edit', 'remodel']) satisfies z.ZodType<ToolId>

const PropertyId = z.string().min(1).max(64)
// More than the kit's properties, and small enough that a report fits the 64 KiB body limit.
const SHOWN_MAX = 900

export const ScreenSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('browse') }),
  z.object({ kind: z.literal('selected'), propertyId: PropertyId }),
  z.object({ kind: z.literal('flythrough'), propertyId: PropertyId, modelId: z.string().min(1).max(64) }),
  z.object({ kind: z.literal('tool'), propertyId: PropertyId, tool: ToolIdSchema }),
]) satisfies z.ZodType<Screen>

export const Lat = z.number().min(-90).max(90)
export const Lon = z.number().min(-180).max(180)
export const Zoom = z.number().min(2).max(21)

export const CameraSchema = z.object({ lat: Lat, lon: Lon, zoom: z.number().min(0).max(24) }) satisfies z.ZodType<Camera>

export const BoundsSchema = z.object({ west: Lon, south: Lat, east: Lon, north: Lat }) satisfies z.ZodType<Bounds>

export const FilterSchema = z.object({
  kind: z.enum(['commercial', 'residential']).nullable(),
  type: z.string().max(80).nullable(),
  sort: z.string().max(40),
  savedOnly: z.boolean(),
}) satisfies z.ZodType<ViewFilter>

export const HighlightSchema = z.object({
  propertyId: PropertyId,
  score: z.number().min(0).max(100).nullable().describe('0 to 100, or null for a match with no score yet.'),
  note: z.string().max(80).optional().describe('At most 80 characters, shown with the pin.'),
}) satisfies z.ZodType<Highlight>

export const ViewSchema = z.object({
  version: z.number().int(),
  screen: ScreenSchema,
  camera: CameraSchema.nullable(),
  bounds: BoundsSchema.nullable(),
  filter: FilterSchema,
  shown: z.array(PropertyId).max(SHOWN_MAX).nullable(),
  highlights: z.array(HighlightSchema).max(HIGHLIGHTS_MAX),
}) satisfies z.ZodType<View>

export const ViewReportSchema = z.strictObject({
  screen: ScreenSchema.optional(),
  camera: CameraSchema.optional(),
  bounds: BoundsSchema.optional(),
  filter: FilterSchema.optional(),
  shown: z.array(PropertyId).max(SHOWN_MAX).optional(),
}) satisfies z.ZodType<ViewReport>

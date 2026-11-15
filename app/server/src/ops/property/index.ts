import { z } from 'zod'
import type { Property } from '../../../../shared/property.ts'
import { defineOp, requireProperty } from '../op.ts'

const PropertyResult = z.object({
  id: z.string(),
  kind: z.enum(['commercial', 'residential']),
  costarId: z.string(),
  name: z.string(),
  address: z.string(),
  lat: z.number(),
  lon: z.number(),
  typeLabel: z.string(),
  facts: z.array(z.object({ label: z.string(), value: z.string() })),
  photoUrl: z.string().nullable(),
  scans: z.array(z.object({ modelId: z.string(), name: z.string() })),
}) satisfies z.ZodType<Property>

const propertyGet = defineOp({
  name: 'property_get',
  summary: 'The curated record of one property: its name, address, location, type, display facts, photo and scans.',
  effect: 'read',
  input: z.object({ propertyId: z.string().describe('A property id from GET /api/properties, such as "commercial-248243".') }),
  output: PropertyResult,
})(async (ctx, { propertyId }) => ({ result: requireProperty(ctx, propertyId) }))

export const PROPERTY_OPS = [propertyGet]

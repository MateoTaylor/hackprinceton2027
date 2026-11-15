import { z } from 'zod'
import { UpstreamError } from '../../vexcel.ts'
import { Assumptions, defineOp, OpError, requireProperty } from '../op.ts'
import { FEATURE_GROUPS, groupAttributes } from './groups.ts'

const RESULT_ATTRIBUTES = 40

const GroupId = z.enum(FEATURE_GROUPS.map(({ group }) => group))
const FeatureGroup = z.object({
  group: GroupId,
  attributes: z.array(z.object({ key: z.string(), value: z.union([z.string(), z.number(), z.boolean()]) })),
})

const FeaturesResult = z.object({
  capturedAt: z.string().describe('The date of the Vexcel capture the attributes come from.'),
  groups: z.array(FeatureGroup).describe(`The first ${RESULT_ATTRIBUTES} attributes, by group.`),
  omittedCount: z.int().min(0).describe('Attributes left out of result. Ask for detail to get them all.'),
  source: z.literal('vexcel'),
  assumptions: Assumptions,
})

const FeaturesDetail = z.object({ groups: z.array(FeatureGroup) })

// Rethrows a Vexcel failure as `upstream` with its status only, and anything else as it is.
function upstream(error: unknown): never {
  if (error instanceof UpstreamError) {
    throw new OpError('upstream', `Vexcel answered ${error.status}.`, 'Vexcel did not answer. Try again in a minute.')
  }
  throw error
}

// Keeps the first `max` attributes in group order, dropping groups that end up empty.
function firstAttributes(groups: z.infer<typeof FeatureGroup>[], max: number) {
  let left = max
  return groups.flatMap(({ group, attributes }) => {
    const kept = attributes.slice(0, left)
    left -= kept.length
    return kept.length ? [{ group, attributes: kept }] : []
  })
}

export const featuresGet = defineOp({
  name: 'features_get',
  summary: 'The Vexcel attributes of a property from its newest capture, such as roof, pool and solar, by group.',
  effect: 'read',
  input: z.object({ propertyId: z.string().describe('A property id from GET /api/properties.') }),
  output: FeaturesResult,
  detail: FeaturesDetail,
})(async (ctx, { propertyId }) => {
  const { lat, lon } = requireProperty(ctx, propertyId)
  const features = await ctx.vexcel.extract(lat, lon, { include: ['precomputed', 'calculated'] }).catch(upstream)
  const newest = features.toSorted((a, b) => b.capturedAt.localeCompare(a.capturedAt) || Number(b.primary) - Number(a.primary))[0]
  const groups = newest ? groupAttributes(newest.attributes) : []
  if (!newest || !groups.length) {
    throw new OpError('no_data', 'Vexcel has no attributes for this property.', 'Vexcel has no attributes at this point. Try a property with a larger building.')
  }
  const total = groups.reduce((sum, { attributes }) => sum + attributes.length, 0)
  return {
    result: {
      capturedAt: newest.capturedAt,
      groups: firstAttributes(groups, RESULT_ATTRIBUTES),
      omittedCount: Math.max(0, total - RESULT_ATTRIBUTES),
      source: 'vexcel',
      assumptions: [
        `Attributes come from the Vexcel capture of ${newest.capturedAt}.`,
        'Vexcel derives them from aerial imagery, so they can lag the building.',
        'Vexcel has no roof age field.',
      ],
    },
    detail: { groups },
  }
})

const DetectLabel = z.object({
  label: z.string(),
  count: z.int().min(0),
  maxConfidence: z.number().min(0).max(1).nullable().describe('The highest confidence among its detections, or null with none.'),
})

const DetectResult = z.object({
  labels: z.array(DetectLabel).describe('One entry per label asked for, zero counts included.'),
  total: z.int().min(0),
  radiusM: z.int(),
  source: z.literal('vexcel'),
  assumptions: Assumptions,
})

const DetectDetail = z.object({
  detections: z.array(z.object({ label: z.string(), confidence: z.number(), bboxWkt: z.string().describe('The box as a WKT polygon in lon lat.') })),
})

export const featuresDetect = defineOp({
  name: 'features_detect',
  summary: 'Finds anything you can name, such as "car" or "solar panel", on the aerial photo around a property, with a count per label.',
  effect: 'read',
  input: z.object({
    propertyId: z.string().describe('A property id from GET /api/properties.'),
    labels: z
      .array(z.string().trim().min(2).max(40))
      .min(1)
      .max(5)
      .describe('Plain-language object names. Specific names such as "above ground pool" beat vague ones.'),
    radiusM: z.int().min(10).max(100).default(40).describe('Half the side of the ground square searched, in metres.'),
    threshold: z.number().min(0.1).max(0.95).default(0.5).describe('Lower finds more and noisier objects.'),
  }),
  output: DetectResult,
  detail: DetectDetail,
})(async (ctx, { propertyId, labels, radiusM, threshold }) => {
  const { lat, lon } = requireProperty(ctx, propertyId)
  const asked = [...new Set(labels)]
  const detections = await ctx.vexcel.detect(lat, lon, { labels: asked, halfM: radiusM, threshold }).catch(upstream)
  return {
    result: {
      labels: asked.map((label) => {
        const found = detections.filter((d) => d.label === label)
        return { label, count: found.length, maxConfidence: found.length ? Math.max(...found.map((d) => d.confidence)) : null }
      }),
      total: detections.length,
      radiusM,
      source: 'vexcel',
      assumptions: [
        `The search covers a ground square reaching ${radiusM} m from the property's pin, not its parcel.`,
        "Vexcel's open-vocabulary model reads the newest straight-down photo, so objects under trees or on walls can be missed.",
        `Detections below a confidence of ${threshold} are left out.`,
      ],
    },
    detail: { detections },
  }
})

export const FEATURES_OPS = [featuresGet, featuresDetect]

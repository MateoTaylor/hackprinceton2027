import { z } from 'zod'
import type { Property } from '../../../../shared/property.ts'
import type { Bounds, Highlight, Move, ToolId } from '../../../../shared/view.ts'
import { BoundsSchema, CameraSchema, FilterSchema, HIGHLIGHTS_MAX, HighlightSchema, Lat, Lon, ScreenSchema, ToolIdSchema, Zoom } from '../../view/schema.ts'
import type { ViewChange, ViewStore } from '../../view/store.ts'
import { Assumptions, defineOp, type Op, OpError, requireProperty } from '../op.ts'

const LIST_MAX = 20
const NO_TAB = 'No browser tab is open. The change shows when one opens.'

// The only property kind a tool opens on. A tool not listed opens on every property.
const TOOL_ONLY: Partial<Record<ToolId, Property['kind']>> = { signage: 'commercial' }

const PropertyIdInput = z.string().describe('A property id from GET /api/properties, such as "commercial-248243".')

const ChangeResult = z.object({
  screen: ScreenSchema,
  highlightCount: z.number().int(),
  attached: z.number().int().describe('How many browser tabs are open.'),
  assumptions: Assumptions,
})

const boxAround = (properties: Iterable<Property>): Bounds | null => {
  let box: Bounds | null = null
  for (const { lat, lon } of properties) {
    box = box
      ? { west: Math.min(box.west, lon), south: Math.min(box.south, lat), east: Math.max(box.east, lon), north: Math.max(box.north, lat) }
      : { west: lon, south: lat, east: lon, north: lat }
  }
  return box
}

const inside = (b: Bounds, { lat, lon }: Property) => lat >= b.south && lat <= b.north && lon >= b.west && lon <= b.east

// The view ops, bound to the server's one view store. Each `view` op applies its change as `op`
// and answers with the screen, the highlight count and how many tabs will show it.
export function createViewOps(store: ViewStore): Op[] {
  const change = (patch: ViewChange, move?: Move, assumptions: string[] = []) => {
    const view = store.apply(patch, 'op', move)
    const attached = store.attached()
    return {
      result: {
        screen: view.screen,
        highlightCount: view.highlights.length,
        attached,
        assumptions: attached === 0 ? [...assumptions, NO_TAB] : assumptions,
      },
    }
  }

  const viewGet = defineOp({
    name: 'view_get',
    summary:
      'What the user sees: the open screen, the map camera and bounds, the properties in bounds, the filter and the highlights. detail lists every highlight.',
    effect: 'read',
    input: z.object({}),
    output: z.object({
      version: z.number().int(),
      screen: ScreenSchema,
      camera: CameraSchema.nullable().describe('What the map last reported, null until a tab reports.'),
      bounds: BoundsSchema.nullable(),
      inView: z
        .object({ count: z.number().int(), propertyIds: z.array(z.string()).describe(`The first ${LIST_MAX}.`) })
        .nullable()
        .describe('The properties inside bounds, null while bounds is null.'),
      filter: FilterSchema,
      highlightCount: z.number().int(),
      highlights: z.array(HighlightSchema).describe(`The first ${LIST_MAX}.`),
      attached: z.number().int(),
    }),
    detail: z.object({ highlights: z.array(HighlightSchema) }),
  })(async (ctx) => {
    const view = store.get()
    const { bounds } = view
    const ids = bounds ? [...ctx.properties.values()].filter((p) => inside(bounds, p)).map((p) => p.id) : null
    return {
      result: {
        version: view.version,
        screen: view.screen,
        camera: view.camera,
        bounds,
        inView: ids && { count: ids.length, propertyIds: ids.slice(0, LIST_MAX) },
        filter: view.filter,
        highlightCount: view.highlights.length,
        highlights: view.highlights.slice(0, LIST_MAX),
        attached: store.attached(),
      },
      detail: { highlights: view.highlights },
    }
  })

  const viewOpen = defineOp({
    name: 'view_open',
    summary:
      "Opens a property on the user's screen: its card, its 3D fly-through or one of its tool panels. The map swoops in to the property.",
    effect: 'view',
    input: z.object({
      propertyId: PropertyIdInput,
      panel: z.union([z.enum(['card', 'flythrough']), ToolIdSchema]).describe('`card`, `flythrough` or a tool id: dollhouse, route, signage, edit or remodel.'),
      modelId: z.string().optional().describe('The scan to fly through. Defaults to the property\'s first scan. Only for `flythrough`.'),
    }),
    output: ChangeResult,
  })(async (ctx, { propertyId, panel, modelId }) => {
    const property = requireProperty(ctx, propertyId)
    if (panel === 'card') return change({ screen: { kind: 'selected', propertyId } })
    if (panel === 'flythrough') {
      const scan = modelId ? property.scans.find((s) => s.modelId === modelId) : property.scans[0]
      if (!scan) {
        if (property.scans.length === 0) throw new OpError('no_data', 'This property has no scan.', 'Pick a property with a scan, or open its card.')
        throw new OpError('not_found', `This property has no scan "${modelId}".`, 'Leave modelId out to open the first scan, or read the scans with property_get.')
      }
      const assumptions = modelId ? [] : [`Opened the first scan, "${scan.name}".`]
      return change({ screen: { kind: 'flythrough', propertyId, modelId: scan.modelId } }, undefined, assumptions)
    }
    const only = TOOL_ONLY[panel]
    if (only && property.kind !== only) throw new OpError('invalid_input', `The ${panel} tool opens only on ${only} properties.`, 'Pick another tool or a property of that kind.')
    return change({ screen: { kind: 'tool', propertyId, tool: panel } })
  })

  const viewFrame = defineOp({
    name: 'view_frame',
    summary: 'Returns to the map and fits the camera around a set of properties, or around every property when propertyIds is left out.',
    effect: 'view',
    input: z.object({
      propertyIds: z.array(PropertyIdInput).min(1).max(HIGHLIGHTS_MAX).optional().describe(`At most ${HIGHLIGHTS_MAX} ids. Leave it out to frame every property.`),
    }),
    output: ChangeResult,
  })(async (ctx, { propertyIds }) => {
    const properties = propertyIds ? propertyIds.map((id) => requireProperty(ctx, id)) : ctx.properties.values()
    const fit = boxAround(properties)
    if (!fit) throw new OpError('no_data', 'There are no properties to frame.', 'Load the properties with the data build first.')
    return change({ screen: { kind: 'browse' } }, { fit })
  })

  const viewCamera = defineOp({
    name: 'view_camera',
    summary: 'Returns to the map and moves the camera to a point and a zoom. A value left out keeps the one the map last reported.',
    effect: 'view',
    input: z
      .object({
        lat: Lat.optional(),
        lon: Lon.optional(),
        zoom: Zoom.optional().describe('From 2 (a continent) to 21 (a rooftop). 17 shows one block.'),
      })
      .refine((i) => i.lat !== undefined || i.lon !== undefined || i.zoom !== undefined, 'Give at least one of lat, lon and zoom.'),
    output: ChangeResult,
  })(async (_ctx, input) => {
    const camera = store.get().camera
    const lat = input.lat ?? camera?.lat
    const lon = input.lon ?? camera?.lon
    const zoom = input.zoom ?? camera?.zoom
    if (lat === undefined || lon === undefined || zoom === undefined) {
      throw new OpError('not_ready', 'No map has reported its camera yet.', 'Give lat, lon and zoom together, or open the web app first.')
    }
    return change({ screen: { kind: 'browse' } }, { lat, lon, zoom })
  })

  const viewHighlight = defineOp({
    name: 'view_highlight',
    summary:
      'Sets the highlighted properties, drawn as pins coloured by score. replace sets the list, add upserts by propertyId, clear empties it.',
    effect: 'view',
    input: z.object({
      mode: z.enum(['replace', 'add', 'clear']),
      items: z.array(HighlightSchema).max(HIGHLIGHTS_MAX).optional().describe(`At most ${HIGHLIGHTS_MAX}. Not used by clear.`),
    }),
    output: ChangeResult,
  })(async (ctx, { mode, items = [] }) => {
    if (mode === 'clear') return change({ highlights: [] })
    for (const { propertyId } of items) requireProperty(ctx, propertyId)
    const highlights = mode === 'replace' ? dedupe(items) : upsert(store.get().highlights, items)
    if (highlights.length > HIGHLIGHTS_MAX) {
      throw new OpError('invalid_input', `The highlights would hold ${highlights.length} properties, over ${HIGHLIGHTS_MAX}.`, 'Use replace with a shorter list, or clear first.')
    }
    return change({ highlights })
  })

  return [viewGet, viewOpen, viewFrame, viewCamera, viewHighlight]
}

// Later items win, and each property keeps the position it first had.
function upsert(current: readonly Highlight[], items: readonly Highlight[]) {
  const byId = new Map(current.map((h) => [h.propertyId, h]))
  for (const item of items) byId.set(item.propertyId, item)
  return [...byId.values()]
}

const dedupe = (items: readonly Highlight[]) => upsert([], items)

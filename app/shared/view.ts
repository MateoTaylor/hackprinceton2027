// What the user sees, shared by the server, the browser and the agent. The server holds one View,
// view ops and the browser tab both write it, and the last write wins.
// Import it with `import type` and a relative path; this file has no runtime code.
import type { PropertyKind } from './property.ts'

// A property tool panel, as `view_open` names it and the property card offers it.
export type ToolId = 'dollhouse' | 'route' | 'signage' | 'edit' | 'remodel'

// What fills the screen: the map alone, a property's card, its fly-through or one of its tool panels.
export type Screen =
  | { kind: 'browse' }
  | { kind: 'selected'; propertyId: string }
  | { kind: 'flythrough'; propertyId: string; modelId: string }
  | { kind: 'tool'; propertyId: string; tool: ToolId }

export interface Camera {
  lat: number
  lon: number
  zoom: number
}

export interface Bounds {
  west: number
  south: number
  east: number
  north: number
}

// The sidebar and header filters as the tab last reported them. `sort` is a web SortKey.
export interface ViewFilter {
  kind: PropertyKind | null
  type: string | null
  sort: string
  savedOnly: boolean
}

// One highlighted property. `score` runs from 0 to 100, and null marks a match with no score yet.
// `note` is at most 80 characters.
export interface Highlight {
  propertyId: string
  score: number | null
  note?: string
}

// `camera` and `bounds` are what the map last reported, null until a tab reports. `shown` is the ids
// the tab's search and filters let through, null until a tab reports; a highlighted property also
// keeps its pin. `version` goes up by one on every change.
export interface View {
  version: number
  screen: Screen
  camera: Camera | null
  bounds: Bounds | null
  filter: ViewFilter
  shown: string[] | null
  highlights: Highlight[]
}

// A request for the map to move. The camera is never set directly, because only the browser knows
// the size of the map: the map moves and the tab reports the camera it reached.
export type Move = { fit: Bounds } | Camera

// `by` is `op`, `server` or a tab's id from the `x-propstar-client` header.
export interface ViewEvent {
  type: 'view'
  view: View
  by: string
  move?: Move
}

// A write op that just succeeded, so an open panel can reload. `propertyId` is the op input's, or
// null when it has none, and `result` is what the op answered.
export interface WriteEvent {
  type: 'write'
  op: string
  by: string
  propertyId: string | null
  result: unknown
}

// One message on `GET /api/events`, sent as the JSON `data` of an unnamed event.
export type ServerEvent = ViewEvent | WriteEvent

// The body of `PUT /api/view`: what the user did in the tab.
export interface ViewReport {
  screen?: Screen
  camera?: Camera
  bounds?: Bounds
  filter?: ViewFilter
  shown?: string[]
}

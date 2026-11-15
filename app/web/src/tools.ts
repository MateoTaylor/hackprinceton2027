import { Box, Eraser, PaintRoller, Route, Signpost, type LucideIcon } from 'lucide-react'
import { lazy, type ComponentType, type LazyExoticComponent } from 'react'
import type { Property, PropertyKind } from '../../shared/property'

// What every panel receives: the selected property and nothing else. A panel fetches the rest
// through `useOp` from ToolPanel.
export type PanelProps = { property: Property }

export type ToolId = 'dollhouse' | 'route' | 'signage' | 'edit' | 'remodel'

export type Tool = {
  id: ToolId
  label: string
  icon: LucideIcon
  panel: LazyExoticComponent<ComponentType<PanelProps>>
  // The only kind of property the tool is offered on. Leave it out to offer the tool on every property.
  only?: PropertyKind
  // The only property ids the tool is offered on, for a tool that works on prepared data.
  onlyIds?: readonly string[]
  // The panel fills the whole frame edge to edge, and ToolPanel floats its title and close button over it.
  canvas?: true
  // Left off the property card. Proppy can still open the panel.
  offCard?: true
}

// 2838 Potomac Ave, the one property with prepared picture edits in its drop folder. See
// app/server/src/ops/edit/README.md.
const PREPARED_EDITS = ['residential-201926017']

// The tools, in the order the property card shows them. Each panel is the default export of
// a file in its lane's folder and loads only when opened.
export const TOOLS: readonly Tool[] = [
  { id: 'dollhouse', label: 'Slice', icon: Box, panel: lazy(() => import('./dollhouse/DollhousePanel')), canvas: true },
  { id: 'route', label: 'Routing', icon: Route, panel: lazy(() => import('./route/RoutePanel')), canvas: true },
  { id: 'signage', label: 'Signage', icon: Signpost, panel: lazy(() => import('./signage/SignagePanel')), only: 'commercial', canvas: true },
  { id: 'edit', label: 'Magic Eraser', icon: Eraser, panel: lazy(() => import('./edit/EditPanel')), onlyIds: PREPARED_EDITS, offCard: true },
  { id: 'remodel', label: 'Remodel', icon: PaintRoller, panel: lazy(() => import('./remodel/RemodelPanel')), onlyIds: PREPARED_EDITS, offCard: true },
]

// The tools that can open on `property`.
export const toolsFor = (property: Property) =>
  TOOLS.filter(({ only, onlyIds }) => (!only || only === property.kind) && (!onlyIds || onlyIds.includes(property.id)))

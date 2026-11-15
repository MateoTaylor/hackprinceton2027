import { Box, Forklift, MapPinned, Route, ScanSearch, Signpost, WandSparkles, type LucideIcon } from 'lucide-react'
import { lazy, type ComponentType, type LazyExoticComponent } from 'react'
import type { Property, PropertyKind } from '../../shared/property'

// What every panel receives: the selected property and nothing else. A panel fetches the rest
// through `useOp` from ToolPanel.
export type PanelProps = { property: Property }

export type ToolId = 'dollhouse' | 'route' | 'scene' | 'signage' | 'area' | 'features' | 'edit'

export type Tool = {
  id: ToolId
  label: string
  icon: LucideIcon
  panel: LazyExoticComponent<ComponentType<PanelProps>>
  // The only kind of property the tool is offered on. Leave it out to offer the tool on every property.
  only?: PropertyKind
}

// The tools, in the order the property card shows them. Each panel is the default export of
// a file in its lane's folder and loads only when opened.
export const TOOLS: readonly Tool[] = [
  { id: 'dollhouse', label: 'Dollhouse', icon: Box, panel: lazy(() => import('./dollhouse/DollhousePanel')) },
  { id: 'route', label: 'Routing', icon: Route, panel: lazy(() => import('./route/RoutePanel')) },
  { id: 'scene', label: 'Scene', icon: Forklift, panel: lazy(() => import('./scene/ScenePanel')) },
  { id: 'signage', label: 'Signage', icon: Signpost, panel: lazy(() => import('./signage/SignagePanel')), only: 'commercial' },
  { id: 'area', label: 'Area', icon: MapPinned, panel: lazy(() => import('./area/AreaPanel')) },
  { id: 'features', label: 'Features', icon: ScanSearch, panel: lazy(() => import('./features/FeaturesPanel')) },
  { id: 'edit', label: 'Edit', icon: WandSparkles, panel: lazy(() => import('./edit/EditPanel')) },
]

// The tools a property card shows for `property`.
export const toolsFor = (property: Property) => TOOLS.filter(({ only }) => !only || only === property.kind)

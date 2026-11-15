import { PictureEditor } from '../edit/PictureEditor'
import type { PanelProps } from '../tools'

// The Remodel panel: give a surface in a scan picture a new material or colour, such as a
// countertop, a floor or a pillow. ToolPanel draws its frame.
export default function RemodelPanel({ property }: PanelProps) {
  return <PictureEditor property={property} tool="remodel" />
}

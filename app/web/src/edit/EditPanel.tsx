import type { PanelProps } from '../tools'
import { PictureEditor } from './PictureEditor'

// The Magic Eraser panel: remove an object from a scan picture. ToolPanel draws its frame.
export default function EditPanel({ property }: PanelProps) {
  return <PictureEditor property={property} tool="erase" />
}

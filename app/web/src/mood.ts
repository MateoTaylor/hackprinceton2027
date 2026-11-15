import { AIMessage, type BaseMessage } from '@langchain/core/messages'
import type { MascotMood } from './mascot/Mascot'

// Tools that read or look something up. Every other tool writes or changes something.
const LOOKUPS = new Set([
  'property_get',
  'property_query',
  'building_get',
  'features_get',
  'features_detect',
  'area_places',
  'area_summary',
  'equipment_list',
  'signage_get',
  'picture_edit_list',
  'view_get',
  'view_aerial',
  'web_search',
  'read_file',
  'task',
])

// The mascot's mood for a run: `idle` when nothing streams, `analyzing` while Proppy's latest tool
// call is a look-up or subagents are running, and `working` while it writes its answer or changes
// something. A run that has produced nothing yet counts as analyzing.
//   <Mascot mood={mascotMood(stream.messages, stream.isLoading, runningSubagents > 0)} />
export function mascotMood(messages: readonly BaseMessage[], streaming: boolean, subagentsRunning: boolean): MascotMood {
  if (!streaming) return 'idle'
  if (subagentsRunning) return 'analyzing'
  const last = messages.findLast((m) => AIMessage.isInstance(m))
  if (!last || messages.at(-1)?.type === 'human') return 'analyzing'
  const call = last.tool_calls?.at(-1)?.name
  if (call) return LOOKUPS.has(call) ? 'analyzing' : 'working'
  const searching = Array.isArray(last.content) && last.content.some((block) => block.type === 'server_tool_use')
  return searching && !last.text.trim() ? 'analyzing' : 'working'
}

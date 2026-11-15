// One write op Proppy wants to run, as the agent's human-in-the-loop interrupt carries it.
export interface ActionRequest {
  name: string
  args: Record<string, unknown>
  description?: string
}

// The answer to one action request. Send one per request, in the order they arrived.
export type Decision = { type: 'approve' } | { type: 'reject'; message?: string }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

// Reads the action requests out of an interrupt's value. Anything that is not an approval
// request gives an empty list, so the panel draws no card for it.
//   const requests = actionRequests(stream.interrupt?.value)
export function actionRequests(value: unknown): ActionRequest[] {
  if (!isRecord(value) || !Array.isArray(value.actionRequests)) return []
  return value.actionRequests.flatMap((request) =>
    isRecord(request) && typeof request.name === 'string' && isRecord(request.args)
      ? [{ name: request.name, args: request.args, description: typeof request.description === 'string' ? request.description : undefined }]
      : [],
  )
}

const LINES: Record<string, string> = {
  signage_place: 'Hang a sign on the building',
  signage_move: 'Move a sign on the building',
  signage_remove: 'Take a sign off the building',
  scene_place: 'Place an object in the 3D scan',
  scene_move: 'Move an object in the 3D scan',
  scene_remove: 'Remove an object from the 3D scan',
  picture_edit_apply: 'Apply a prepared edit to a scan picture',
}

// "bottomM" reads "bottom (m)", "facingDeg" reads "facing (°)", "sizeM.widthM" reads "size width (m)".
function label(path: string[]) {
  const last = path.at(-1) ?? ''
  const unit = /[a-z]Deg$/.test(last) ? ' (°)' : /[a-z]M$/.test(last) ? ' (m)' : ''
  const words = path.map((key) => key.replace(/(?<=[a-z])(M|Deg)$/, '')).join(' ')
  return words.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase() + unit
}

const round = (n: number) => String(Math.round(n * 100) / 100)

// Every id and number in the arguments, nested objects flattened. Other strings are left out,
// because the model writes them and the card only vouches for what the op will act on.
function printable(value: unknown, path: string[]): [string, string][] {
  if (typeof value === 'number' && Number.isFinite(value)) return [[label(path), round(value)]]
  if (typeof value === 'string' && /id$/i.test(path.at(-1) ?? '')) return [[label(path), value]]
  if (Array.isArray(value) && value.length && value.every((n) => typeof n === 'number')) return [[label(path), value.map(round).join(', ')]]
  if (isRecord(value)) return Object.entries(value).flatMap(([key, inner]) => printable(inner, [...path, key]))
  return []
}

// The approval card's text: one line that says what will happen, and the arguments as label and
// value pairs. A write op with no line here falls back to its manifest summary, then its name.
//   const { line, args } = describeAction(request)
export function describeAction({ name, args, description }: ActionRequest) {
  return { line: LINES[name] ?? description ?? name, args: printable(args, []) }
}

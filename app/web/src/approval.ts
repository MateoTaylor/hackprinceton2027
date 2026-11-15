// One write op Proppy wants to run, as the agent's human-in-the-loop interrupt carries it.
export interface ActionRequest {
  name: string
  args: Record<string, unknown>
  description?: string
}

// The answer to one action request. Send one per request, in the order they arrived.
export type Decision = { type: 'approve' } | { type: 'reject'; message?: string }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const asRequest = (request: unknown): ActionRequest | undefined =>
  isRecord(request) && typeof request.name === 'string' && isRecord(request.args)
    ? { name: request.name, args: request.args, description: typeof request.description === 'string' ? request.description : undefined }
    : undefined

// Reads a paused run's interrupt. `requests` holds one slot per action request, in order, so the
// decisions sent back always match them one to one. A slot the card cannot read is undefined, and
// any such slot, or an interrupt that is not an approval request at all, makes the batch
// rejectable only (`approvable` is false).
//   const { requests, approvable } = readInterrupt(stream.interrupt?.value)
//   stream.respond({ decisions: requests.map(() => ({ type: 'reject' })) }, ...)
export function readInterrupt(value: unknown) {
  const requests = isRecord(value) && Array.isArray(value.actionRequests) ? value.actionRequests.map(asRequest) : []
  return { requests, approvable: requests.length > 0 && requests.every((r) => r !== undefined) }
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

// Long strings are cut here so one argument cannot push the rest of the card out of view.
const MAX_TEXT = 120
const clip = (text: string) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text)

// Every argument the op will act on, nested objects flattened. Strings are shown too, cut to
// MAX_TEXT, because a string such as a sign's text or an edit's command picks the effect, and the
// user must see it before approving. Other arrays and nulls show as compact JSON, cut the same way.
function printable(value: unknown, path: string[]): [string, string][] {
  if (typeof value === 'number' && Number.isFinite(value)) return [[label(path), round(value)]]
  if (typeof value === 'string') return [[label(path), clip(value)]]
  if (typeof value === 'boolean') return [[label(path), value ? 'yes' : 'no']]
  if (Array.isArray(value) && value.length && value.every((n) => typeof n === 'number')) return [[label(path), value.map(round).join(', ')]]
  if (Array.isArray(value) && value.length && value.every((s) => typeof s === 'string')) return [[label(path), clip(value.join(', '))]]
  if (Array.isArray(value) || value === null) return [[label(path), clip(JSON.stringify(value))]]
  if (isRecord(value)) return Object.entries(value).flatMap(([key, inner]) => printable(inner, [...path, key]))
  return []
}

// The approval card's text: one line that says what will happen, and the arguments as label and
// value pairs. A write op with no line here falls back to its manifest summary, then its name.
//   const { line, args } = describeAction(request)
export function describeAction({ name, args, description }: ActionRequest) {
  return { line: LINES[name] ?? description ?? name, args: printable(args, []) }
}

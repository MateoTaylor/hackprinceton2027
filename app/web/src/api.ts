import type { Property } from '../../shared/property'
import { clientId } from './view.ts'

export async function getJson(path: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(path, { signal })
  if (!res.ok) throw new Error(`${path} answered ${res.status}`)
  return res.json()
}

export async function fetchProperties(signal?: AbortSignal): Promise<Property[]> {
  const body = await getJson('/api/properties', signal)
  if (!Array.isArray(body)) throw new Error('/api/properties did not return a list')
  return body
}

export const thumbUrl = (id: string) => `/api/thumb/${encodeURIComponent(id)}`

// The failure `callOp` throws. `code` is the op's error code, or `unreachable` or `bad_response`
// when no op answered. `hint` says what to do next, so a panel shows it under the message.
export class OpCallError extends Error {
  readonly code: string
  readonly hint: string

  constructor(code: string, message: string, hint: string) {
    super(message)
    this.name = 'OpCallError'
    this.code = code
    this.hint = hint
  }
}

const API_HINT = 'Check that the Propstar API is running on the port the web app proxies to.'

// Runs one op through POST /api/ops/:name. `detail: true` asks for the op's detail as well:
//   const { result } = await callOp<PropertyResult>('property_get', { propertyId })
// An aborted `signal` rejects with the fetch's own AbortError. Every other failure is an OpCallError.
export async function callOp<Result, Detail = undefined>(
  name: string,
  input: object,
  { detail = false, signal }: { detail?: boolean; signal?: AbortSignal } = {},
): Promise<{ result: Result; detail: Detail }> {
  const response = await fetch(`/api/ops/${encodeURIComponent(name)}${detail ? '?detail=full' : ''}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-propstar-client': clientId },
    body: JSON.stringify(input),
    signal,
  }).catch((error: unknown) => {
    if (signal?.aborted) throw error
    throw new OpCallError('unreachable', `${name} could not reach the Propstar API.`, API_HINT)
  })
  const body: unknown = await response.json().catch((error: unknown) => {
    if (signal?.aborted) throw error
  })
  if (isEnvelope(body)) {
    if (body.ok) return { result: body.result as Result, detail: body.detail as Detail }
    throw new OpCallError(body.error.code, body.error.message, body.error.hint)
  }
  throw new OpCallError('bad_response', `${name} answered ${response.status} without an op envelope.`, API_HINT)
}

type Envelope = { ok: true; result: unknown; detail?: unknown } | { ok: false; error: { code: string; message: string; hint: string } }

function isEnvelope(body: unknown): body is Envelope {
  if (typeof body !== 'object' || body === null || !('ok' in body)) return false
  if (body.ok === true) return 'result' in body
  if (body.ok !== false || !('error' in body)) return false
  const { error } = body
  return typeof error === 'object' && error !== null && ['code', 'message', 'hint'].every((key) => typeof Reflect.get(error, key) === 'string')
}

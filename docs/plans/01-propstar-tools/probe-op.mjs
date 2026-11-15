#!/usr/bin/env node
// Calls one op on the local server and prints what came back without printing the data: the
// status, the size of `result` and an outline of keys, types and counts. Op results derive from
// licensed data, so check an op with this script and never paste a response body.
//
//   node probe-op.mjs building_get propertyId=commercial-248243
//   node probe-op.mjs route_solve propertyId=commercial-248243 payload=wheelchair --detail
//   node probe-op.mjs building_get propertyId=commercial-248243 --show result.heightM
//
// The input is `key=value` pairs. A dotted key sets a nested field. A value that parses as JSON is
// sent as JSON, and any other value is sent as a string. `--port` defaults to PROPSTAR_PORT, then
// 8787. `--show` repeats and prints one number, boolean or short string by its dotted path. The
// script exits 1 when the op fails or does not answer in 90 seconds, so a check for an error case
// expects exit 1.

const TIMEOUT_MS = 90_000
const SHOW_MAX_CHARS = 80
const OUTLINE_DEPTH = 3

function fail(lines) {
  for (const line of lines) console.error(line)
  process.exit(1)
}

const usage = () => fail(['usage: node probe-op.mjs <op> [key=value ...] [--port <n>] [--detail] [--show <path> ...]'])

function parseValue(text) {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function setPath(target, path, value) {
  const keys = path.split('.')
  const last = keys.pop()
  let node = target
  for (const key of keys) node = node[key] ??= {}
  node[last] = value
}

function parseArgs(argv) {
  const [op, ...rest] = argv
  if (!op || !/^[a-z][a-z0-9_]{2,40}$/.test(op)) usage()
  const parsed = { op, input: {}, show: [], detail: false, port: process.env.PROPSTAR_PORT ?? '8787' }
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    const equals = arg.indexOf('=')
    if (arg === '--detail') parsed.detail = true
    else if (arg === '--port' && rest[i + 1]) parsed.port = rest[++i]
    else if (arg === '--show' && rest[i + 1]) parsed.show.push(rest[++i])
    else if (equals > 0 && !arg.startsWith('--')) setPath(parsed.input, arg.slice(0, equals), parseValue(arg.slice(equals + 1)))
    else usage()
  }
  if (!/^\d{2,5}$/.test(parsed.port)) fail([`--port takes a port number, not "${parsed.port}"`])
  return parsed
}

function describe(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `array(${value.length})`
  if (typeof value === 'object') return `object(${Object.keys(value).length})`
  if (typeof value === 'string') return `string(${value.length})`
  return typeof value
}

function outline(value, indent, depth) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return
  for (const [key, child] of Object.entries(value)) {
    console.log(`${indent}${key}: ${describe(child)}`)
    if (depth > 1) outline(child, `${indent}  `, depth - 1)
  }
}

function showValue(root, path) {
  const value = path.split('.').reduce((node, key) => node?.[key], root)
  const scalar = typeof value === 'number' || typeof value === 'boolean' || (typeof value === 'string' && value.length <= SHOW_MAX_CHARS)
  console.log(`${path} = ${value === undefined ? 'missing' : scalar ? JSON.stringify(value) : describe(value)}`)
}

const { op, input, show, detail, port } = parseArgs(process.argv.slice(2))
const path = `/api/ops/${op}${detail ? '?detail=full' : ''}`

const response = await fetch(`http://127.0.0.1:${port}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(input),
  signal: AbortSignal.timeout(TIMEOUT_MS),
}).catch((error) =>
  fail([error.name === 'TimeoutError' ? `${op} did not answer within ${TIMEOUT_MS / 1000} seconds` : `no server answered on 127.0.0.1:${port}`]),
)

const text = await response.text()
let body
try {
  body = JSON.parse(text)
} catch {
  fail([`POST ${path} ${response.status}, and the body is not JSON (${text.length} chars)`])
}

console.log(`POST ${path} ${response.status} ${body.ok ? 'ok' : 'failed'}`)
if (!body.ok) fail([`${body.error?.code}: ${body.error?.message}`, `hint: ${body.error?.hint}`])

console.log(`result ${JSON.stringify(body.result).length} chars`)
outline(body.result, '  ', OUTLINE_DEPTH)
if (detail) {
  console.log(`detail ${JSON.stringify(body.detail ?? null).length} chars`)
  outline(body.detail, '  ', OUTLINE_DEPTH)
}
for (const shown of show) showValue(body, shown)

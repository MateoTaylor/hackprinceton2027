// Client test for the edit API, for the web app laptop. Node 24 only, nothing to install.
// From the repo root, with EDIT_API_URL and EDIT_API_TOKEN in .env (both from Mateo, privately):
//
//   node --env-file=.env tools/edit_api/client_test.ts                 link, scan and one edit
//   node --env-file=.env tools/edit_api/client_test.ts --check         link and scan only
//   node --env-file=.env tools/edit_api/client_test.ts --save out/     also saves the preview and changed faces
//
// Saved pictures are licensed scan pictures: keep them out of git and off any upload.
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

const { values: opt } = parseArgs({
  options: {
    base: { type: 'string', default: process.env.EDIT_API_URL ?? 'http://127.0.0.1:2026' },
    model: { type: 'string', default: 'zzvymDx5ty7' },
    pano: { type: 'string', default: '6zup806u9qfn91xq0hbdk5yna' },
    yaw: { type: 'string', default: '270' },
    pitch: { type: 'string', default: '-14' },
    fov: { type: 'string', default: '70' },
    command: { type: 'string', default: 'remove the throw pillows and the tray from the bed' },
    save: { type: 'string' },
    check: { type: 'boolean', default: false },
  },
})
const base = opt.base.trim().replace(/\/+$/, '')
const key = process.env.EDIT_API_TOKEN?.trim()
if (!key) {
  console.error('EDIT_API_TOKEN is not set. Put the key from Mateo in the repo-root .env and run with --env-file=.env.')
  process.exit(1)
}
const auth = { Authorization: `Bearer ${key}` }

const HINTS: Record<number, string> = {
  401: 'the key is wrong: check EDIT_API_TOKEN',
  403: 'the API refuses this laptop\'s address: ask Mateo to allow it (the error says which address it saw)',
  503: 'the queue is full: try again in a few minutes',
}

async function call(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(base + path, { ...init, headers: { ...auth, ...(init.headers as object) } })
  const json = res.headers.get('content-type')?.includes('json')
  const body = json ? await res.json() : Buffer.from(await res.arrayBuffer())
  if (!res.ok) {
    const hint = HINTS[res.status] ? ` (${HINTS[res.status]})` : ''
    throw new Error(`${init.method ?? 'GET'} ${path} answered ${res.status}${hint}: ${JSON.stringify(json ? body : '')}`)
  }
  return body
}

// Reads a server-sent event stream with fetch, since EventSource cannot send the key header.
async function* events(path: string) {
  const res = await fetch(base + path, { headers: { ...auth, Accept: 'text/event-stream' } })
  if (!res.ok || !res.body) throw new Error(`GET ${path} answered ${res.status}`)
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n')
    for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
      const block = buffer.slice(0, end)
      buffer = buffer.slice(end + 2)
      let event = 'message'
      let data = ''
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) data += line.slice(5).trim()
      }
      if (data) yield { event, data: JSON.parse(data) }
    }
  }
}

// 1. The link: /health needs no key.
try {
  const health = await (await fetch(`${base}/health`, { signal: AbortSignal.timeout(8000) })).json()
  console.log(`link ok: ${base} answers, runner ${health.runner}`)
} catch (err) {
  console.error(`Cannot reach ${base} (${(err as Error).message}). Is this laptop on the campus VPN, and is EDIT_API_URL right?`)
  process.exit(2)
}

async function main() {
  // 2. The key and the scan.
  const place = await call(`/places/${opt.model}`)
  console.log(`key ok. scan ${place.model_id}: downloaded ${place.downloaded}, mesh ${place.has_mesh}, ${place.panos.length} panoramas`)
  if (opt.check) return

  // 3. One edit, followed to the end.
  const job = await call('/edits', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      place: { model_id: opt.model },
      start: { pano_id: opt.pano, yaw: Number(opt.yaw), pitch: Number(opt.pitch), fov: Number(opt.fov) },
      command: opt.command,
    }),
  })
  console.log(`job ${job.job_id}: ${job.status}, queue position ${job.queue_position}`)

  let result: any = null
  for await (const { event, data } of events(`/edits/${job.job_id}/events`)) {
    if (event === 'status') console.log(`  status ${data.status}${data.queue_position ? `, queue position ${data.queue_position}` : ''}`)
    else if (event === 'step') {
      const where = data.pano === undefined ? 'api' : `pano ${data.pano} view ${data.view ?? '-'}`
      console.log(`  ${where.padEnd(16)} ${data.step.padEnd(12)} ${data.status}${data.seconds != null ? ` ${data.seconds} s` : ''}`)
    } else if (event === 'failed') {
      console.error(`failed: ${data.code}: ${data.message}`)
      process.exit(1)
    } else if (event === 'done') result = data
  }
  if (!result) throw new Error('the stream ended without a result')

  console.log(`done${result.stub ? ' (STUB: a finished case, not an edit of this view)' : ''}. verdict ${result.report.verdict}`)
  for (const p of result.panos) {
    console.log(`  pano ${p.index} (${p.id}): faces changed ${JSON.stringify(p.changed)}, verdict ${p.verdict}, ${p.views.length} view(s)`)
  }
  if (result.note) console.log(`  note: ${result.note}`)

  if (opt.save) {
    await mkdir(opt.save, { recursive: true })
    await writeFile(join(opt.save, 'preview.jpg'), await call(result.preview))
    let n = 1
    for (const p of result.panos) {
      for (const f of p.changed) {
        await writeFile(join(opt.save, `p${p.index}_f${f}.jpg`), await call(p.faces[f]))
        n++
      }
    }
    console.log(`saved the preview and ${n - 1} changed faces in ${opt.save}`)
  }
}

try {
  await main()
} catch (err) {
  console.error((err as Error).message)
  process.exit(1)
}

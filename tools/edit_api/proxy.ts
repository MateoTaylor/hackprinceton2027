// Forwards the web app's /api/edit/* requests to the edit API on Mateo's PC and adds the key there,
// so the browser never holds the key and can use plain URLs: <img src>, three.js TextureLoader and
// EventSource all work on /api/edit/... paths.
//
// Web standards only (Request, Response, fetch): no package to install, and Node 24 runs it as is.
// In the Hono server (app/server/src/app.ts), copy this file next to app.ts or import it, then:
//
//   app.all('/api/edit/*', (c) =>
//     forwardEdit(c.req.raw, { base: process.env.EDIT_API_URL, key: process.env.EDIT_API_TOKEN }))
//
// EDIT_API_URL (http://<PC address>:2026) and EDIT_API_TOKEN come from Mateo, privately, into the
// repo-root .env. A path in a result, such as /edits/<job>/files/p6_f3.jpg, becomes
// /api/edit/edits/<job>/files/p6_f3.jpg in the browser.

export const PREFIX = '/api/edit'

// Request headers the edit API reads. Everything else, cookies included, stays on this laptop.
const PASS_REQUEST = ['content-type', 'accept', 'last-event-id']
// Response headers worth keeping. Content-Length is left to Node, since the body is streamed.
const PASS_RESPONSE = ['content-type', 'cache-control']

type Options = { base?: string; key?: string; prefix?: string }

const fail = (status: number, code: string, message: string) =>
  Response.json({ error: { code, message } }, { status })

export async function forwardEdit(req: Request, opts: Options): Promise<Response> {
  const prefix = opts.prefix ?? PREFIX
  const base = opts.base?.trim().replace(/\/+$/, '')
  const key = opts.key?.trim()
  if (!base || !key) {
    return fail(503, 'edit_api_not_configured', 'Set EDIT_API_URL and EDIT_API_TOKEN in the repo-root .env.')
  }
  const url = new URL(req.url)
  if (!url.pathname.startsWith(prefix + '/')) return fail(404, 'not_found', `Edit API paths start with ${prefix}/.`)

  const headers = new Headers({ Authorization: `Bearer ${key}` })
  for (const name of PASS_REQUEST) {
    const value = req.headers.get(name)
    if (value) headers.set(name, value)
  }
  let res: Response
  try {
    res = await fetch(base + url.pathname.slice(prefix.length) + url.search, {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer(),
      signal: req.signal, // the browser closing an event stream also closes it on the PC
    })
  } catch {
    if (req.signal.aborted) return new Response(null, { status: 499 })
    return fail(502, 'edit_api_unreachable', 'Cannot reach the edit API. Is this laptop on the campus VPN, and is EDIT_API_URL right?')
  }
  const out = new Headers()
  for (const name of PASS_RESPONSE) {
    const value = res.headers.get(name)
    if (value) out.set(name, value)
  }
  return new Response(res.body, { status: res.status, headers: out })
}

import type { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { streamSSE } from 'hono/streaming'
import type { ServerEvent } from '../../../shared/view.ts'
import { ViewReportSchema } from './schema.ts'
import type { ViewStore } from './store.ts'

const BODY_MAX_BYTES = 64 * 1024
// Every tab expects a `ping` this often and reopens a stream that stays silent past STALE_MS in web/src/view.ts.
const HEARTBEAT_MS = 10_000
const CLIENT_ID = /^[A-Za-z0-9-]{1,64}$/

// Who sent a request: the tab id in `x-propstar-client`, or `unknown`.
export function clientOf(header: string | undefined) {
  return header && CLIENT_ID.test(header) ? header : 'unknown'
}

// GET /api/events streams the view to one tab: the current view first (by `server`), then every
// event as the JSON `data` of an unnamed message, with an empty `ping` event every 10 s.
// PUT /api/view takes a ViewReport from a tab and answers `{version}`, or 400 when the body fails.
export function mountView(app: Hono, store: ViewStore) {
  app.get('/api/events', (c) =>
    streamSSE(c, async (stream) => {
      const send = (event: ServerEvent) => void stream.writeSSE({ data: JSON.stringify(event) }).catch(() => stream.abort())
      send({ type: 'view', view: store.get(), by: 'server' })
      const unsubscribe = store.subscribe(send)
      const heartbeat = setInterval(() => void stream.writeSSE({ event: 'ping', data: '' }).catch(() => stream.abort()), HEARTBEAT_MS)
      await new Promise<void>((resolve) => stream.onAbort(resolve))
      clearInterval(heartbeat)
      unsubscribe()
    }),
  )

  app.put(
    '/api/view',
    bodyLimit({ maxSize: BODY_MAX_BYTES, onError: (c) => c.json({ error: `The body is over ${BODY_MAX_BYTES} bytes.` }, 400) }),
    async (c) => {
      const body: unknown = await c.req.json().catch(() => undefined)
      const report = ViewReportSchema.safeParse(body)
      if (!report.success) return c.json({ error: 'The body is not a view report.' }, 400)
      const view = store.apply(report.data, clientOf(c.req.header('x-propstar-client')))
      return c.json({ version: view.version })
    },
  )
}

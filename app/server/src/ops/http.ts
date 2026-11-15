import type { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { OpEnvelope, OpErrorCode } from './op.ts'
import type { Registry } from './registry.ts'
import type { WriteEvent } from '../../../shared/view.ts'
import { clientOf } from '../view/routes.ts'

const BODY_MAX_BYTES = 64 * 1024

const STATUS = {
  invalid_input: 400,
  not_found: 404,
  not_ready: 503,
  no_data: 404,
  upstream: 502,
  conflict: 409,
  internal: 500,
} as const satisfies Record<OpErrorCode, ContentfulStatusCode>

// Serves a registry over HTTP under `prefix`. GET <prefix> lists its ops. POST <prefix>/:name runs
// one with the JSON object body as its input and answers with the envelope. `?detail=full` adds
// `detail`. The status follows the error code, and 200 means `ok`. `onWrite` runs after a `write` op
// answers `ok`, with the op's name, the caller's `x-propstar-client` header or `unknown`, the
// input's `propertyId` and the op's result.
//   mountOps(app, publicRegistry, '/api/ops', view.publishWrite)
//   mountOps(app, proppyRegistry, '/api/proppy/ops')
export function mountOps(app: Hono, registry: Registry, prefix: string, onWrite: (write: Omit<WriteEvent, 'type'>) => void = () => {}) {
  const badBody = (message: string): OpEnvelope => ({
    ok: false,
    error: { code: 'invalid_input', message, hint: `Send the input as one JSON object, as GET ${prefix} describes it.` },
  })

  app.get(prefix, (c) => c.json({ ops: registry.manifest() }))

  app.post(
    `${prefix}/:name`,
    bodyLimit({ maxSize: BODY_MAX_BYTES, onError: (c) => c.json(badBody(`body: The body is over ${BODY_MAX_BYTES} bytes.`), STATUS.invalid_input) }),
    async (c) => {
      const name = c.req.param('name')
      if (!registry.get(name)) {
        const unknown: OpEnvelope = { ok: false, error: { code: 'not_found', message: `No op is named "${name}".`, hint: `List the ops with GET ${prefix}.` } }
        return c.json(unknown, STATUS.not_found)
      }
      let input: unknown
      try {
        input = await c.req.json()
      } catch {
        return c.json(badBody('body: The body is not JSON.'), STATUS.invalid_input)
      }
      const answer = await registry.run(name, input, { detail: c.req.query('detail') === 'full' })
      if (answer.ok && registry.get(name)?.effect === 'write') {
        const propertyId = input && typeof input === 'object' && 'propertyId' in input && typeof input.propertyId === 'string' ? input.propertyId : null
        onWrite({ op: name, by: clientOf(c.req.header('x-propstar-client')), propertyId, result: answer.result })
      }
      return c.json(answer, answer.ok ? 200 : STATUS[answer.error.code])
    },
  )
}

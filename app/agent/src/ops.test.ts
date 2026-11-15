import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { approvals, connectOps } from './ops.ts'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

const op = (name: string, effect: 'read' | 'write' | 'view') => ({ name, summary: `${name} summary`, effect, input: { type: 'object' }, output: {} })

// A fake API: each manifest route answers with its ops (or 404 when left out), and every POST is
// recorded and answered with the route it reached.
function fakeApi(manifests: Partial<Record<'/api/ops' | '/api/proppy/ops', ReturnType<typeof op>[]>>) {
  const posts: string[] = []
  globalThis.fetch = async (url, init) => {
    const path = new URL(String(url)).pathname
    if (init?.method === 'POST') {
      posts.push(path)
      return Response.json({ ok: true, result: { path } })
    }
    const ops = manifests[path as keyof typeof manifests]
    return ops ? Response.json({ ops }) : new Response('not found', { status: 404 })
  }
  return posts
}

test('ops from both manifests become one list, and each call goes to its own route', async () => {
  const posts = fakeApi({
    '/api/ops': [op('property_get', 'read'), op('scene_place', 'write'), op('view_open', 'view')],
    '/api/proppy/ops': [op('area_summary', 'read'), op('property_query', 'read'), op('property_get', 'read')],
  })
  const ops = await connectOps('http://api.test')
  assert.deepEqual(
    ops.manifest.map((o) => o.name),
    ['property_get', 'scene_place', 'view_open', 'area_summary', 'property_query'],
  )
  assert.deepEqual(Object.keys(approvals(ops)), ['scene_place'])

  for (const name of ['area_summary', 'property_get', 'property_query']) await ops.call(name, {})
  assert.deepEqual(posts, ['/api/proppy/ops/area_summary', '/api/ops/property_get', '/api/proppy/ops/property_query'])
})

test('a missing Proppy manifest drops only its ops, and a missing public one is unreachable', async () => {
  fakeApi({ '/api/ops': [op('property_get', 'read')] })
  assert.deepEqual((await connectOps('http://api.test')).manifest.map((o) => o.name), ['property_get'])

  fakeApi({ '/api/proppy/ops': [op('area_summary', 'read')] })
  await assert.rejects(connectOps('http://api.test'), /The Propstar API is not reachable/)
})

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { callOp, OpCallError } from './api.ts'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

function fakeFetch(body: string, status: number) {
  const calls: { url: string; init?: RequestInit }[] = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return new Response(body, { status, headers: { 'content-type': 'application/json' } })
  }
  return calls
}

test('callOp posts the input and returns result and detail', async () => {
  const calls = fakeFetch(JSON.stringify({ ok: true, result: { rooms: 3 }, detail: { mesh: [1, 2] } }), 200)
  const answer = await callOp<{ rooms: number }, { mesh: number[] }>('building_get', { propertyId: 'p-1' }, { detail: true })
  assert.deepEqual(answer, { result: { rooms: 3 }, detail: { mesh: [1, 2] } })
  assert.equal(calls[0].url, '/api/ops/building_get?detail=full')
  assert.equal(calls[0].init?.method, 'POST')
  assert.equal(calls[0].init?.body, JSON.stringify({ propertyId: 'p-1' }))
})

test('callOp asks for no detail unless told to', async () => {
  const calls = fakeFetch(JSON.stringify({ ok: true, result: {} }), 200)
  const answer = await callOp('property_get', { propertyId: 'p-1' })
  assert.equal(calls[0].url, '/api/ops/property_get')
  assert.equal(answer.detail, undefined)
})

test('callOp throws the error envelope as an OpCallError', async () => {
  fakeFetch(JSON.stringify({ ok: false, error: { code: 'not_ready', message: 'No model yet.', hint: 'Run the build.' } }), 503)
  await assert.rejects(callOp('building_get', { propertyId: 'p-1' }), (error) => {
    assert.ok(error instanceof OpCallError)
    assert.deepEqual([error.code, error.message, error.hint], ['not_ready', 'No model yet.', 'Run the build.'])
    return true
  })
})

test('callOp throws bad_response when the answer is not JSON', async () => {
  fakeFetch('<html>Bad gateway</html>', 502)
  await assert.rejects(callOp('area_places', {}), (error) => {
    assert.ok(error instanceof OpCallError)
    assert.equal(error.code, 'bad_response')
    assert.match(error.message, /502/)
    return true
  })
})

test('callOp throws unreachable when fetch fails, and passes an abort through', async () => {
  globalThis.fetch = async () => {
    throw new TypeError('fetch failed')
  }
  await assert.rejects(callOp('area_places', {}), (error) => error instanceof OpCallError && error.code === 'unreachable')

  const controller = new AbortController()
  controller.abort()
  globalThis.fetch = async () => {
    throw new DOMException('aborted', 'AbortError')
  }
  await assert.rejects(callOp('area_places', {}, { signal: controller.signal }), { name: 'AbortError' })
})

test('callOp passes an abort through while the body is being read', async () => {
  const controller = new AbortController()
  globalThis.fetch = async () => {
    controller.abort()
    return new Response(new ReadableStream({ start: (stream) => stream.error(new DOMException('aborted', 'AbortError')) }))
  }
  await assert.rejects(callOp('area_places', {}, { signal: controller.signal }), { name: 'AbortError' })
})

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { createDiskCache } from './cache.ts'
import { assertReadOnly, createMatterport } from './matterport.ts'
import { OpError } from './ops/op.ts'

const roots: string[] = []
after(() => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))))

const MODEL = 'AbCdEfGh123'

// An invented plan: one floor, an office walled by e1 and e2, and a room with every optional field null.
const PLAN = {
  data: {
    model: {
      floors: [
        {
          id: 'f1',
          label: null,
          sequence: 0,
          vertices: [{ id: 'v1', position: { x: 0, y: 0 } }, { id: 'v2', position: { x: 4, y: 0 } }],
          edges: [
            {
              id: 'e1',
              type: 'wall',
              thickness: 0.1,
              vertices: [{ id: 'v1' }, { id: 'v2' }],
              openings: [{ id: 'o1', type: 'doorway', width: 0.9, height: 2.1, lowerElevation: 0, relativeCenter: 0.5 }],
            },
          ],
        },
      ],
      rooms: [
        {
          id: 'r1',
          label: 'Office',
          floor: { id: 'f1' },
          holes: [],
          boundary: { edges: [{ id: 'e1' }, { id: 'e2' }] },
          classifications: [{ label: 'Office', confidence: 0.9 }],
          ceiling: { minHeight: 2.7, maxHeight: 3 },
        },
        { id: 'r2', label: null, floor: null, holes: null, boundary: null, classifications: null, ceiling: null },
      ],
    },
  },
}

async function fakeMatterport(respond: () => Response) {
  const root = await mkdtemp(join(tmpdir(), 'propstar-matterport-'))
  roots.push(root)
  const requests: { url: string; init: RequestInit | undefined }[] = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), init })
    return respond()
  }
  return { requests, matterport: createMatterport({ tokenId: 'id', tokenSecret: 'secret', cache: createDiskCache(root), fetch }) }
}

const isOpError = (code: string, message?: string) => (error: unknown) =>
  error instanceof OpError && error.code === code && (message === undefined || error.message === message)

test('graphql refuses a mutation and any query that names unlockModelBundle', () => {
  assert.throws(() => assertReadOnly('mutation { unlockModelBundle(id: "x") { id } }'))
  assert.throws(() => assertReadOnly('MUTATION Buy { x }'))
  assert.throws(() => assertReadOnly('query { model(id: "x") { unlockModelBundle } }'))
  assert.doesNotThrow(() => assertReadOnly('query ($id: ID!) { model(id: $id) { id } }'))
})

test('a bad model id never reaches fetch', async () => {
  const { requests, matterport } = await fakeMatterport(() => Response.json(PLAN))
  for (const id of ['short', 'AbCdEfGh12!', 'AbCdEfGh1234', '../AbCdEfGh']) {
    await assert.rejects(matterport.floorPlan(id), isOpError('invalid_input'))
  }
  assert.equal(requests.length, 0)
})

test('floorPlan asks for geometry only, parses floors and rooms, and reads a second call from the cache', async () => {
  const { requests, matterport } = await fakeMatterport(() => Response.json(PLAN))
  const plan = await matterport.floorPlan(MODEL)

  assert.equal(requests.length, 1)
  const [{ url, init }] = requests
  assert.equal(url, 'https://api.matterport.com/api/models/graph')
  assert.equal(new Headers(init?.headers).get('authorization'), `Basic ${Buffer.from('id:secret').toString('base64')}`)
  const body = JSON.parse(String(init?.body))
  assert.deepEqual(body.variables, { id: MODEL })
  assert.doesNotMatch(body.query, /url|assets|mutation/i)

  assert.deepEqual(plan.floors, [
    {
      id: 'f1',
      label: '',
      sequence: 0,
      vertices: [{ id: 'v1', x: 0, y: 0 }, { id: 'v2', x: 4, y: 0 }],
      edges: [
        {
          id: 'e1',
          type: 'wall',
          thickness: 0.1,
          vertexIds: ['v1', 'v2'],
          openings: [{ id: 'o1', type: 'doorway', widthM: 0.9, heightM: 2.1, lowerElevationM: 0, relativeCenter: 0.5 }],
        },
      ],
    },
  ])
  assert.deepEqual(plan.rooms, [
    {
      id: 'r1',
      label: 'Office',
      floorId: 'f1',
      boundaryEdgeIds: ['e1', 'e2'],
      holeEdgeIds: [],
      classifications: [{ label: 'Office', confidence: 0.9 }],
      ceiling: { minHeight: 2.7, maxHeight: 3 },
    },
    { id: 'r2', label: '', floorId: null, boundaryEdgeIds: [], holeEdgeIds: [], classifications: [], ceiling: null },
  ])

  assert.deepEqual(await matterport.floorPlan(MODEL), plan)
  assert.equal(requests.length, 1)
})

test('every failure is upstream with the status only, and nothing failed is cached', async () => {
  const cases: [() => Response, string][] = [
    [() => new Response('secret detail', { status: 500 }), 'Matterport answered 500.'],
    [() => Response.json({ errors: [{ message: 'secret detail' }], data: null }), 'Matterport answered 200 with GraphQL errors.'],
    [() => new Response('<html>secret detail</html>', { status: 200 }), 'Matterport answered 200 with an unexpected shape.'],
    [() => { throw new TypeError('secret detail') }, 'Matterport did not answer.'],
  ]
  for (const [respond, message] of cases) {
    const { requests, matterport } = await fakeMatterport(respond)
    await assert.rejects(matterport.floorPlan(MODEL), isOpError('upstream', message))
    await assert.rejects(matterport.floorPlan(MODEL), isOpError('upstream', message))
    assert.equal(requests.length, 2, message)
  }
})

test('a model Matterport does not return is no_data', async () => {
  const { matterport } = await fakeMatterport(() => Response.json({ data: { model: null } }))
  await assert.rejects(matterport.floorPlan(MODEL), isOpError('no_data'))
})

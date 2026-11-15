import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { DiskCache } from './cache.ts'
import { OpError } from './ops/op.ts'
import { limiter, parseJson } from './vexcel.ts'

const ENDPOINT = 'https://api.matterport.com/api/models/graph'
const MAX_CONCURRENT = 2
const TIMEOUT_MS = 30_000
const MODEL_ID = /^[A-Za-z0-9]{11}$/

// Asks for geometry and labels only. Asset fields carry URLs that Matterport signs, so the query
// names none of them.
const FLOOR_PLAN_QUERY = `query FloorPlan($id: ID!) {
  model(id: $id) {
    floors { id label sequence
      vertices { id position { x y } }
      edges { id type thickness vertices { id }
        openings { id type width height lowerElevation relativeCenter } } }
    rooms { id label floor { id } holes { edges { id } } boundary { edges { id } }
      classifications { label confidence }
      ceiling { minHeight maxHeight } }
  }
}`

// Throws when `query` is a mutation or names unlockModelBundle, the Matterport call that spends money.
export function assertReadOnly(query: string) {
  if (/mutation|unlockModelBundle/i.test(query)) throw new Error('The Matterport client sends read-only queries only.')
}

const upstream = (what: string) =>
  new OpError('upstream', `Matterport ${what}.`, 'Matterport did not answer as expected. Try again in a minute.')

const Ids = z.array(z.object({ id: z.string() }))

// A room's boundary or holes as a flat list of edge ids. Matterport sends either one path or a list
// of paths.
const EdgePaths = z
  .union([z.object({ edges: Ids }), z.array(z.object({ edges: Ids }))])
  .nullish()
  .transform((paths) => [paths ?? []].flat().flatMap(({ edges }) => edges.map(({ id }) => id)))

const Opening = z
  .object({
    id: z.string(),
    type: z.string(),
    width: z.number(),
    height: z.number().nullish(),
    lowerElevation: z.number().nullish(),
    relativeCenter: z.number().nullish(),
  })
  .transform(({ id, type, width, height, lowerElevation, relativeCenter }) => ({
    id,
    type,
    widthM: width,
    heightM: height ?? null,
    lowerElevationM: lowerElevation ?? null,
    relativeCenter: relativeCenter ?? null,
  }))

const Edge = z
  .object({ id: z.string(), type: z.string().nullish(), thickness: z.number().nullish(), vertices: Ids, openings: z.array(Opening).nullish() })
  .transform(({ id, type, thickness, vertices, openings }) => ({
    id,
    type: type ?? null,
    thickness: thickness ?? null,
    vertexIds: vertices.map((v) => v.id),
    openings: openings ?? [],
  }))

const Floor = z
  .object({
    id: z.string(),
    label: z.string().nullish(),
    sequence: z.number(),
    vertices: z.array(z.object({ id: z.string(), position: z.object({ x: z.number(), y: z.number() }) })).nullish(),
    edges: z.array(Edge).nullish(),
  })
  .transform(({ id, label, sequence, vertices, edges }) => ({
    id,
    label: label ?? '',
    sequence,
    vertices: (vertices ?? []).map(({ id, position: { x, y } }) => ({ id, x, y })),
    edges: edges ?? [],
  }))

const Room = z
  .object({
    id: z.string(),
    label: z.string().nullish(),
    floor: z.object({ id: z.string() }).nullish(),
    holes: EdgePaths,
    boundary: EdgePaths,
    classifications: z.array(z.object({ label: z.string(), confidence: z.number().nullish() })).nullish(),
    ceiling: z.object({ minHeight: z.number().nullish(), maxHeight: z.number().nullish() }).nullish(),
  })
  .transform(({ id, label, floor, holes, boundary, classifications, ceiling }) => ({
    id,
    label: label ?? '',
    floorId: floor?.id ?? null,
    boundaryEdgeIds: boundary,
    holeEdgeIds: holes,
    classifications: (classifications ?? []).map(({ label, confidence }) => ({ label, confidence: confidence ?? null })),
    ceiling: ceiling ? { minHeight: ceiling.minHeight ?? null, maxHeight: ceiling.maxHeight ?? null } : null,
  }))

const Envelope = z.object({ data: z.unknown(), errors: z.array(z.unknown()).nullish() })

const FloorPlanData = z.object({
  model: z.object({ floors: z.array(Floor).nullish(), rooms: z.array(Room).nullish() }).nullable(),
})

// One scan's floor plan in the scan's own frame. Vertex positions and opening sizes are in metres.
export type FloorPlan = { floors: z.output<typeof Floor>[]; rooms: z.output<typeof Room>[] }

// The Matterport Model API, read-only. A good answer is cached on disk by a hash of its query and
// variables, so a scan is fetched once. floorPlan rejects with an OpError: `invalid_input` for a bad
// model id, `no_data` for a model Matterport does not return, and `upstream` for the rest, whose
// message never carries Matterport's response text.
//   const plan = await matterport.floorPlan('aYTUWzQVbUs')
export function createMatterport({
  tokenId,
  tokenSecret,
  cache,
  fetch = globalThis.fetch,
}: {
  tokenId: string
  tokenSecret: string
  cache: DiskCache
  fetch?: typeof globalThis.fetch
}) {
  const limit = limiter(MAX_CONCURRENT)
  const authorization = `Basic ${Buffer.from(`${tokenId}:${tokenSecret}`).toString('base64')}`

  async function attempt(body: string) {
    const started = performance.now()
    const done = (outcome: number | string) => console.log(`matterport graphql ${outcome} ${Math.round(performance.now() - started)}ms`)
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: authorization, 'Content-Type': 'application/json' },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!res.ok) await res.body?.cancel()
      const bytes = res.ok ? new Uint8Array(await res.arrayBuffer()) : null
      done(res.status)
      return { status: res.status, bytes }
    } catch {
      done('failed')
      return null
    }
  }

  // Parses before storing, so an answer with GraphQL errors or an unexpected shape is never cached.
  async function graphql<T>(query: string, variables: Record<string, string>, data: z.ZodType<T>) {
    assertReadOnly(query)
    const parse = (body: Uint8Array) => {
      const answer = Envelope.safeParse(parseJson(new TextDecoder().decode(body)))
      if (answer.success && answer.data.errors?.length) throw upstream('answered 200 with GraphQL errors')
      const parsed = data.safeParse(answer.data?.data)
      if (!parsed.success) throw upstream('answered 200 with an unexpected shape')
      return parsed.data
    }
    const key = `graphql/${createHash('sha256').update(JSON.stringify([query, variables])).digest('hex')}`
    const answer = await cache.get(key, () =>
      limit(async () => {
        const res = await attempt(JSON.stringify({ query, variables }))
        if (!res) throw upstream('did not answer')
        if (!res.bytes) throw upstream(`answered ${res.status}`)
        parse(res.bytes)
        return { status: 200, contentType: 'application/json', body: res.bytes }
      }, true),
    )
    if (answer.status !== 200) throw upstream(`answered ${answer.status}`)
    return parse(answer.body)
  }

  return {
    floorPlan: async (modelId: string): Promise<FloorPlan> => {
      if (!MODEL_ID.test(modelId)) {
        throw new OpError('invalid_input', 'A Matterport model id is 11 letters and digits.', 'Read the model ids from the property record.')
      }
      const { model } = await graphql(FLOOR_PLAN_QUERY, { id: modelId }, FloorPlanData)
      if (!model) throw new OpError('no_data', 'Matterport returned no model for this id.', 'Pick another scan of this property.')
      return { floors: model.floors ?? [], rooms: model.rooms ?? [] }
    },
  }
}

export type Matterport = ReturnType<typeof createMatterport>

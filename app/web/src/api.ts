import type { Property } from '../../shared/property'
import type { Direction, ObliqueIndex } from '../../shared/api'

export const DIRECTIONS = ['north', 'east', 'south', 'west'] as const satisfies readonly Direction[]

// Vexcel names an oblique by the way its camera faces, so the map turns to face the same way.
export const BEARING: Record<Direction, number> = { north: 0, east: 90, south: 180, west: 270 }

const isDirection = (value: unknown): value is Direction => DIRECTIONS.some((d) => d === value)

async function getJson(path: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(path, { signal })
  if (!res.ok) throw new Error(`${path} answered ${res.status}`)
  return res.json()
}

export async function fetchProperties(signal?: AbortSignal): Promise<Property[]> {
  const body = await getJson('/api/properties', signal)
  if (!Array.isArray(body)) throw new Error('/api/properties did not return a list')
  return body
}

// A property with no obliques answers an empty list. Any error status throws, 404 included,
// because the index only 404s for an id the server does not know.
export async function fetchObliqueDirections(id: string, signal?: AbortSignal): Promise<Direction[]> {
  const path = `/api/oblique/${encodeURIComponent(id)}`
  const body = await getJson(path, signal)
  if (typeof body !== 'object' || body === null || !('directions' in body) || !Array.isArray(body.directions)) {
    throw new Error(`${path} did not return a direction list`)
  }
  const listed: ObliqueIndex['directions'] = body.directions.filter(isDirection)
  return DIRECTIONS.filter((d) => listed.includes(d))
}

export const obliqueUrl = (id: string, dir: Direction) => `/api/oblique/${encodeURIComponent(id)}/${dir}`
export const thumbUrl = (id: string) => `/api/thumb/${encodeURIComponent(id)}`

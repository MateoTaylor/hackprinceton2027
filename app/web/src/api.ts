import type { Property } from '../../shared/property'

export async function getJson(path: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(path, { signal })
  if (!res.ok) throw new Error(`${path} answered ${res.status}`)
  return res.json()
}

export async function fetchProperties(signal?: AbortSignal): Promise<Property[]> {
  const body = await getJson('/api/properties', signal)
  if (!Array.isArray(body)) throw new Error('/api/properties did not return a list')
  return body
}

export const thumbUrl = (id: string) => `/api/thumb/${encodeURIComponent(id)}`

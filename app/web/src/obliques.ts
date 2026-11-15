import { useCallback, useSyncExternalStore } from 'react'
import type { Direction, LngLat, ObliquePose } from '../../shared/api'
import { getJson } from './api'

export const DIRECTIONS = ['north', 'east', 'south', 'west'] as const satisfies readonly Direction[]

// One angled photo, decoded and ready to drape on the map at the aircraft's pose.
export type ObliqueView = ObliquePose & { direction: Direction; image: ImageBitmap }

// The angled photos of one property. While loading, `first` holds the pose of the photo that will
// show first as soon as its headers arrive, before its bytes. `ready` holds that photo once it
// decodes, and the others join `views` as they arrive, in DIRECTIONS order.
export type Obliques =
  | { status: 'loading'; first?: ObliquePose }
  | { status: 'none' }
  | { status: 'error' }
  | { status: 'ready'; views: ObliqueView[] }

type Entry = { state: Obliques; controller: AbortController; listeners: Set<() => void> }

// Two properties stay decoded, the one shown and the one it replaced, so going back is instant and
// the old photos can fade out. Each holds at most four bitmaps of at most LONG_SIDE pixels.
const KEEP = 2
const LONG_SIDE = 2560
const FIRST_VIEW_TIMEOUT = 12_000
const CLOSE_DELAY = 1000

const LOADING: Obliques = { status: 'loading' }
const entries = new Map<string, Entry>()

const obliqueUrl = (id: string, dir?: Direction) => `/api/oblique/${encodeURIComponent(id)}${dir ? `/${dir}` : ''}`

// The angled photos of property `id`, loading them on first use. A property whose load failed loads
// again the next time something starts watching it.
export function useObliques(id: string | null) {
  const subscribe = useCallback((notify: () => void) => (id ? watch(id, notify) : () => {}), [id])
  return useSyncExternalStore(subscribe, () => (id && entries.get(id)?.state) || LOADING)
}

function watch(id: string, notify: () => void) {
  let entry = entries.get(id)
  if (entry?.state.status === 'error' && entry.listeners.size === 0) {
    evict(id, entry)
    entry = undefined
  }
  if (!entry) {
    entry = { state: LOADING, controller: new AbortController(), listeners: new Set() }
    load(id, entry)
  }
  entries.delete(id)
  entries.set(id, entry)
  entry.listeners.add(notify)
  for (const [other, old] of entries) {
    if (entries.size <= KEEP) break
    if (old.listeners.size === 0) evict(other, old)
  }
  const watched = entry
  return () => {
    watched.listeners.delete(notify)
  }
}

// The bitmaps close a moment later, because the map may still be fading out the photos of a property
// the user just left.
function evict(id: string, entry: Entry) {
  entries.delete(id)
  entry.controller.abort()
  const { state } = entry
  if (state.status === 'ready') setTimeout(() => state.views.forEach((view) => view.image.close()), CLOSE_DELAY)
}

function publish(entry: Entry, state: Obliques) {
  entry.state = state
  for (const notify of entry.listeners) notify()
}

// The index and the north photo are fetched together, because north is the photo shown first. A
// first photo that fails or takes too long hands over to the next direction, one at a time, since
// the server answers the newest urgent request first. The rest are fetched together after it,
// including any that failed as the first.
async function load(id: string, entry: Entry) {
  const signal = entry.controller.signal
  const firstTry = (dir: Direction) =>
    fetchView(id, dir, AbortSignal.any([signal, AbortSignal.timeout(FIRST_VIEW_TIMEOUT)]), (first) => {
      if (!signal.aborted && entry.state.status === 'loading') publish(entry, { status: 'loading', first })
    }).catch(() => null)
  const north = firstTry('north')
  try {
    const index = await getJson(obliqueUrl(id), signal)
    if (typeof index !== 'object' || index === null || !('directions' in index) || !Array.isArray(index.directions)) throw new Error('Malformed oblique index')
    const listed = index.directions
    const directions = DIRECTIONS.filter((d) => listed.includes(d))
    if (!directions.length) return publish(entry, { status: 'none' })
    let view: ObliqueView | null = null
    for (const dir of directions) {
      view = await (dir === 'north' ? north : firstTry(dir))
      if (signal.aborted) return
      if (view) break
    }
    if (!view) return publish(entry, { status: 'error' })
    performance.mark('oblique:decoded', { detail: id })
    publish(entry, { status: 'ready', views: [view] })
    const shown = view.direction
    await Promise.all(
      directions
        .filter((dir) => dir !== shown)
        .map(async (dir) => {
          const next = await fetchView(id, dir, signal).catch(() => null)
          if (!next) return
          if (entry.state.status !== 'ready' || signal.aborted) return next.image.close()
          const views = [...entry.state.views, next].toSorted((a, b) => DIRECTIONS.indexOf(a.direction) - DIRECTIONS.indexOf(b.direction))
          publish(entry, { status: 'ready', views })
        }),
    )
  } catch {
    if (!signal.aborted) publish(entry, { status: 'error' })
  }
}

// One photo with its pose, or null when the property has no photo that way or its pose is unreadable.
// `onPose` hears the pose as soon as the headers arrive. A copy the browser cached from an older
// server has no pose header or an older shape, so it is fetched again once.
async function fetchView(id: string, direction: Direction, signal: AbortSignal, onPose?: (pose: ObliquePose) => void): Promise<ObliqueView | null> {
  let res = await fetch(obliqueUrl(id, direction), { signal })
  let pose = parsePose(res.headers.get('X-Oblique-Pose'))
  if (res.ok && !pose) {
    res = await fetch(obliqueUrl(id, direction), { signal, cache: 'reload' })
    pose = parsePose(res.headers.get('X-Oblique-Pose'))
  }
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`${res.url} answered ${res.status}`)
  if (!pose) return null
  onPose?.(pose)
  const blob = await res.blob()
  const shrink = Math.min(1, LONG_SIDE / Math.max(pose.width, pose.height))
  const image = await createImageBitmap(blob, shrink < 1 ? { resizeWidth: Math.round(pose.width * shrink), resizeHeight: Math.round(pose.height * shrink), resizeQuality: 'high' } : {})
  if (signal.aborted) {
    image.close()
    throw signal.reason
  }
  return { ...pose, direction, image }
}

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isLngLat = (v: unknown): v is LngLat => Array.isArray(v) && v.length === 2 && v.every(isNumber)

function isFocus(v: unknown): v is ObliquePose['focus'] {
  return (
    typeof v === 'object' && v !== null &&
    'center' in v && isLngLat(v.center) &&
    'x' in v && isNumber(v.x) &&
    'y' in v && isNumber(v.y) &&
    'width' in v && isNumber(v.width) &&
    'height' in v && isNumber(v.height)
  )
}

function isPose(v: unknown): v is ObliquePose {
  return (
    typeof v === 'object' && v !== null &&
    'width' in v && isNumber(v.width) &&
    'height' in v && isNumber(v.height) &&
    'bearing' in v && isNumber(v.bearing) &&
    'pitch' in v && isNumber(v.pitch) &&
    'metresPerPixel' in v && isNumber(v.metresPerPixel) &&
    'focus' in v && isFocus(v.focus) &&
    'quad' in v && Array.isArray(v.quad) && v.quad.length === 4 && v.quad.every(isLngLat) &&
    'capturedOn' in v && typeof v.capturedOn === 'string'
  )
}

function parsePose(header: string | null) {
  try {
    const pose: unknown = header && JSON.parse(header)
    return isPose(pose) ? pose : null
  } catch {
    return null
  }
}

let hover: { id: string; timer: number } | null = null
const HOVER_DELAY = 150

// Hovering a property for a moment fetches its north photo into the browser's HTTP cache, so a click
// that follows finds the photo already on its way. Leaving before the delay cancels it. A fetch
// that has started is left to finish, because the server keeps fetching from Vexcel either way.
export function prefetch(id: string) {
  if (hover?.id === id || entries.has(id)) return
  cancelPrefetch()
  const timer = window.setTimeout(() => {
    fetch(obliqueUrl(id, 'north'))
      .then((res) => res.blob())
      .catch(() => {})
  }, HOVER_DELAY)
  hover = { id, timer }
}

export function cancelPrefetch() {
  if (hover) clearTimeout(hover.timer)
  hover = null
}

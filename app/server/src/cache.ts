import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'

// An upstream answer worth keeping. A 404 is stored too, so repeat misses never go upstream.
export type Cached = { status: 200; contentType: string; body: Uint8Array<ArrayBuffer> } | { status: 404 }

const Meta = z.discriminatedUnion('status', [
  z.object({ status: z.literal(200), contentType: z.string() }),
  z.object({ status: z.literal(404) }),
])

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

// Maps a slash-separated key such as `tiles/urban/19/1/2` to a path under root. Every segment must
// start with a letter or digit, so a key can never climb out of root.
export function cacheFile(root: string, key: string) {
  const segments = key.split('/')
  if (!segments.every((s) => SEGMENT.test(s))) throw new Error(`Invalid cache key: ${key}`)
  return join(root, ...segments)
}

// A disk cache of upstream answers. Each key is `<key>.meta` (status and content-type) plus
// `<key>.body` for a 200. `get` returns the stored answer or runs `fetch` once, however many callers
// ask for the same key at the same time. When `fetch` throws, nothing is stored. A missing or
// unreadable entry counts as a miss and is fetched again.
export function createDiskCache(root: string) {
  const inflight = new Map<string, Promise<Cached>>()

  async function read(file: string): Promise<Cached | null> {
    try {
      const meta = Meta.safeParse(JSON.parse(await readFile(`${file}.meta`, 'utf8')))
      if (!meta.success) return null
      if (meta.data.status === 404) return { status: 404 }
      return { status: 200, contentType: meta.data.contentType, body: await readFile(`${file}.body`) }
    } catch (error) {
      if (error instanceof SyntaxError) return null
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
      throw error
    }
  }

  // The meta file goes last, so a crash between the two writes leaves a miss, not a body without meta.
  async function write(file: string, entry: Cached) {
    await mkdir(dirname(file), { recursive: true })
    if (entry.status === 200) await atomicWrite(`${file}.body`, entry.body)
    const meta = entry.status === 200 ? { status: 200, contentType: entry.contentType } : { status: 404 }
    await atomicWrite(`${file}.meta`, JSON.stringify(meta))
  }

  async function load(key: string, fetch: () => Promise<Cached>) {
    const file = cacheFile(root, key)
    const stored = await read(file)
    if (stored) return stored
    const fresh = await fetch()
    await write(file, fresh)
    return fresh
  }

  return {
    get(key: string, fetch: () => Promise<Cached>) {
      const pending = inflight.get(key)
      if (pending) return pending
      const promise = load(key, fetch).finally(() => inflight.delete(key))
      inflight.set(key, promise)
      return promise
    },
  }
}

export type DiskCache = ReturnType<typeof createDiskCache>

async function atomicWrite(file: string, data: Uint8Array | string) {
  const temp = `${file}.${randomUUID()}.tmp`
  await writeFile(temp, data)
  await rename(temp, file)
}

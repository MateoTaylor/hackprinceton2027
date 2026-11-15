import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
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

const isMissing = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT'

// Byte budgets keyed by a key's first segment, such as `{ oblique: 250e6 }`. A prefix with no
// budget grows without bound.
export type Budgets = Record<string, number>

// The least recently used order and byte total of one budgeted prefix. A Map iterates in insertion
// order, so re-inserting a key on every use keeps the oldest first. The order survives a restart
// through each meta file's mtime, which a hit bumps.
type Ledger = { cap: number; bytes: number; entries: Map<string, number> }

// A disk cache of upstream answers. Each key is `<key>.meta` (status and content-type) plus
// `<key>.body` for a 200. `get` returns the stored answer or runs `fetch` once, however many callers
// ask for the same key at the same time. When `fetch` throws, nothing is stored. A missing or
// unreadable entry counts as a miss and is fetched again. After a write pushes a budgeted prefix
// over its budget, the least recently used entries of that prefix are deleted.
export function createDiskCache(root: string, budgets: Budgets = {}) {
  const inflight = new Map<string, Promise<Cached>>()
  const ledgers = new Map(
    Object.entries(budgets).map(([prefix, cap]) => [
      prefix,
      scan(root, prefix).then(async (entries) => {
        const ledger = ledgerOf(cap, entries)
        await evict(ledger)
        return ledger
      }),
    ]),
  )

  async function read(file: string): Promise<Cached | null> {
    try {
      const meta = Meta.safeParse(JSON.parse(await readFile(`${file}.meta`, 'utf8')))
      if (!meta.success) return null
      if (meta.data.status === 404) return { status: 404 }
      return { status: 200, contentType: meta.data.contentType, body: await readFile(`${file}.body`) }
    } catch (error) {
      if (error instanceof SyntaxError || isMissing(error)) return null
      throw error
    }
  }

  // The meta file goes last, so a crash between the two writes leaves a miss, not a body without meta.
  async function write(file: string, entry: Cached) {
    await mkdir(dirname(file), { recursive: true })
    if (entry.status === 200) await atomicWrite(`${file}.body`, entry.body)
    const meta = JSON.stringify(entry.status === 200 ? { status: 200, contentType: entry.contentType } : { status: 404 })
    await atomicWrite(`${file}.meta`, meta)
    return (entry.status === 200 ? entry.body.byteLength : 0) + meta.length
  }

  // The body goes first, so a crash between the two leaves a meta whose body is missing, which reads
  // as a miss. A file that will not go, such as one Windows holds open, is left behind and logged:
  // the load that pushed the prefix over budget has already succeeded.
  async function evict(ledger: Ledger) {
    for (const [key, bytes] of ledger.entries) {
      if (ledger.bytes <= ledger.cap) return
      ledger.entries.delete(key)
      ledger.bytes -= bytes
      const file = cacheFile(root, key)
      try {
        await rm(`${file}.body`, { force: true })
        await rm(`${file}.meta`, { force: true })
      } catch (error) {
        console.log(`cache could not evict ${key}: ${error}`)
      }
    }
  }

  async function load(key: string, fetch: () => Promise<Cached>) {
    const file = cacheFile(root, key)
    const ledger = await ledgers.get(key.split('/')[0])
    const stored = await read(file)
    if (stored) {
      const bytes = ledger?.entries.get(key)
      if (ledger && bytes !== undefined) {
        ledger.entries.delete(key)
        ledger.entries.set(key, bytes)
        const now = new Date()
        utimes(`${file}.meta`, now, now).catch(() => {})
      }
      return stored
    }
    const fresh = await fetch()
    const bytes = await write(file, fresh)
    if (ledger) {
      ledger.bytes += bytes - (ledger.entries.get(key) ?? 0)
      ledger.entries.delete(key)
      ledger.entries.set(key, bytes)
      await evict(ledger)
    }
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

    // Bytes on disk and the budget for each budgeted prefix. It rejects when a startup scan failed.
    async usage() {
      const pairs = await Promise.all([...ledgers].map(async ([prefix, ledger]) => [prefix, await ledger] as const))
      return Object.fromEntries(pairs.map(([prefix, { bytes, cap, entries }]) => [prefix, { bytes, cap, entries: entries.size }]))
    },
  }
}

export type DiskCache = ReturnType<typeof createDiskCache>

function ledgerOf(cap: number, entries: { key: string; bytes: number; used: number }[]): Ledger {
  const sorted = entries.toSorted((a, b) => a.used - b.used)
  return {
    cap,
    bytes: sorted.reduce((sum, e) => sum + e.bytes, 0),
    entries: new Map(sorted.map((e) => [e.key, e.bytes])),
  }
}

// Every entry stored under one prefix, with its size on disk and when it was last used.
async function scan(root: string, prefix: string) {
  let files: string[]
  try {
    files = await readdir(join(root, prefix), { recursive: true })
  } catch (error) {
    if (isMissing(error)) return []
    throw error
  }
  const metas = files.filter((f) => f.endsWith('.meta'))
  const entries = await Promise.all(
    metas.map(async (name) => {
      const file = join(root, prefix, name.slice(0, -'.meta'.length))
      const meta = await stat(`${file}.meta`).catch(() => null)
      if (!meta) return null
      const body = await stat(`${file}.body`).catch(() => null)
      const key = relative(root, file).split(sep).join('/')
      return { key, bytes: meta.size + (body?.size ?? 0), used: meta.mtimeMs }
    }),
  )
  return entries.filter((e) => e !== null)
}

async function atomicWrite(file: string, data: Uint8Array | string) {
  const temp = `${file}.${randomUUID()}.tmp`
  await writeFile(temp, data)
  await rename(temp, file)
}

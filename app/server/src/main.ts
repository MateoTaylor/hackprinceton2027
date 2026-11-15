// Starts the Propstar API on 127.0.0.1, on PROPSTAR_PORT or 8787. Run it with `pnpm dev`, which loads
// the repo-root .env.
import { serve } from '@hono/node-server'
import { fileURLToPath } from 'node:url'
import { createApp } from './app.ts'
import { createDiskCache } from './cache.ts'
import { loadProperties } from './properties.ts'
import { createVexcel } from './vexcel.ts'

const HOST = '127.0.0.1'
const PORT = Number(process.env.PROPSTAR_PORT || 8787)
const DATA = new URL('../../../data/propstar/', import.meta.url)

const apiKey = process.env.VEXCEL_API_KEY?.trim()
if (!apiKey) {
  console.error('VEXCEL_API_KEY is missing. Add it to the repo-root .env and start the server with `pnpm dev`.')
  process.exit(1)
}

const properties = await loadProperties(fileURLToPath(new URL('propstar.duckdb', DATA)))
const MB = 1_000_000
// Measured per entry: oblique about 2.6 MB (a 150-220 m square at full resolution), tile 48 KB,
// parcel 119 KB, thumb 44 KB, coverage 5 KB. The oblique budget holds about 95 photos, or 24
// properties seen from every side.
const cache = createDiskCache(fileURLToPath(new URL('cache/vexcel/', DATA)), {
  oblique: 250 * MB,
  tiles: 1000 * MB,
  parcel: 64 * MB,
  thumb: 32 * MB,
  'oblique-coverage': 8 * MB,
})
const usage = await cache.usage()
const app = createApp({
  base: {
    properties: new Map(properties.map((p) => [p.id, p])),
    vexcel: createVexcel({ apiKey, cache }),
    dataDir: fileURLToPath(DATA),
  },
})

serve({ fetch: app.fetch, hostname: HOST, port: PORT }, () => {
  console.log(`Propstar API on http://${HOST}:${PORT}/api with ${properties.length} properties`)
  console.log(`cache ${Object.entries(usage).map(([prefix, u]) => `${prefix} ${Math.round(u.bytes / MB)}/${u.cap / MB} MB`).join(', ')}`)
})

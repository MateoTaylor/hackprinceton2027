// Starts the Propstar API on 127.0.0.1:8787. Run it with `pnpm dev`, which loads the repo-root .env.
import { serve } from '@hono/node-server'
import { fileURLToPath } from 'node:url'
import { createApp } from './app.ts'
import { createDiskCache } from './cache.ts'
import { loadProperties } from './properties.ts'
import { createVexcel } from './vexcel.ts'

const HOST = '127.0.0.1'
const PORT = 8787
const DATA = new URL('../../../data/propstar/', import.meta.url)

const apiKey = process.env.VEXCEL_API_KEY?.trim()
if (!apiKey) {
  console.error('VEXCEL_API_KEY is missing. Add it to the repo-root .env and start the server with `pnpm dev`.')
  process.exit(1)
}

const properties = await loadProperties(fileURLToPath(new URL('propstar.duckdb', DATA)))
const cache = createDiskCache(fileURLToPath(new URL('cache/vexcel/', DATA)))
const app = createApp({ properties, vexcel: createVexcel({ apiKey, cache }) })

serve({ fetch: app.fetch, hostname: HOST, port: PORT }, () => {
  console.log(`Propstar API on http://${HOST}:${PORT}/api with ${properties.length} properties`)
})

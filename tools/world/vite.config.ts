import { resolve } from 'node:path'
import { defineConfig } from 'vite'

const scanDir = resolve(import.meta.dirname, process.env.SCAN_DIR ?? '../../data/JEaAkySdA5X')

/**
 * The repo root holds `.env` and the rest of the licensed data, so the dev server is
 * narrowed three ways. It binds to localhost. It may read only this package plus one
 * scan's `manifest.json` and `bundles/`, which leaves out the scan's `raw_locations.json`
 * and its signed Matterport URLs. It answers no cross-origin reads, and it refuses the
 * route that opens any file in the editor, which would put `.env` on a recorded screen.
 * Point it at another scan with `SCAN_DIR=<folder> pnpm dev`.
 */
export default defineConfig({
  define: { __SCAN_BASE__: JSON.stringify(`/@fs/${scanDir.replaceAll('\\', '/').replace(/^\//, '')}`) },
  plugins: [
    {
      name: 'refuse-open-in-editor',
      configureServer(server) {
        server.middlewares.use('/__open-in-editor', (_request, response) => {
          response.statusCode = 403
          response.end()
        })
      },
    },
  ],
  server: {
    host: 'localhost',
    port: 5183,
    strictPort: true,
    cors: false,
    fs: {
      strict: true,
      allow: [import.meta.dirname, resolve(scanDir, 'manifest.json'), resolve(scanDir, 'bundles')],
    },
  },
})

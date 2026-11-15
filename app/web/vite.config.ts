import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

const webRoot = fileURLToPath(new URL('.', import.meta.url))
const serverModel = fileURLToPath(new URL('../server/src/model/', import.meta.url))

const webPort = Number(process.env.PROPSTAR_WEB_PORT || 5173)
const apiPort = Number(process.env.PROPSTAR_PORT || 8787)

const matterportMount = '/node_modules/@matterport/webcomponent/built-bundle'
const matterportBundle = join(webRoot, matterportMount)

const matterportTypes: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
}

// Serves the Matterport viewer's own files as they are on disk. Vite would otherwise rewrite its
// pages and scripts as app code, and the viewer then fails to start.
const matterportBundleRaw: Plugin = {
  name: 'matterport-bundle-raw',
  configureServer(server) {
    server.middlewares.use(matterportMount, (req, res, next) => {
      const file = join(matterportBundle, normalize(decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname)))
      const type = matterportTypes[extname(file)]
      if (!file.startsWith(matterportBundle) || !type) return next()
      readFile(file).then(
        (body) => res.setHeader('Content-Type', type).end(body),
        () => next(),
      )
    })
  },
}

export default defineConfig({
  plugins: [react(), matterportBundleRaw],
  server: {
    host: 'localhost',
    port: webPort,
    strictPort: true,
    proxy: { '/api': `http://127.0.0.1:${apiPort}` },
    fs: { strict: true, allow: [webRoot, serverModel] },
  },
  preview: { host: 'localhost' },
})

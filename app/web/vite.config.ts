import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const webRoot = fileURLToPath(new URL('.', import.meta.url))
const serverModel = fileURLToPath(new URL('../server/src/model/', import.meta.url))

const webPort = Number(process.env.PROPSTAR_WEB_PORT || 5173)
const apiPort = Number(process.env.PROPSTAR_PORT || 8787)

export default defineConfig({
  plugins: [react()],
  server: {
    host: 'localhost',
    port: webPort,
    strictPort: true,
    proxy: { '/api': `http://127.0.0.1:${apiPort}` },
    fs: { strict: true, allow: [webRoot, serverModel] },
  },
  preview: { host: 'localhost' },
})

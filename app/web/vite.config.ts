import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const webRoot = fileURLToPath(new URL('.', import.meta.url))

// The repo root holds `.env` and licensed data, so the dev server may read only this package.
export default defineConfig({
  plugins: [react()],
  server: {
    host: 'localhost',
    port: 5173,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:8787' },
    fs: { strict: true, allow: [webRoot] },
  },
  preview: { host: 'localhost' },
})

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  // The demo build is served from a sub-path (github.io/SmartWatt/), so assets
  // use relative URLs. Routing is hash-based, so no server rewrites are needed.
  base: mode === 'demo' ? './' : '/',
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8000', changeOrigin: true, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // three.js (~560 kB) is a deliberate on-demand chunk loaded only by the 3D
    // home card, so the default 500 kB warning is noise for this app.
    chunkSizeWarningLimit: 700,
  },
}))

/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      workbox: {
        // The four SQLite WASM builds are 1-2.5 MB each and only one is used, so they are NOT precached (that would
        // download ~8 MB on every install). They are cached on first use instead: a device that has started the
        // sync runtime once has the engine offline from then on. JS chunks (incl. the lazy sync chunk) are precached.
        globPatterns: ['**/*.{js,css,html,ico,png,svg,webmanifest}'],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.endsWith('.wasm'),
            handler: 'CacheFirst',
            options: { cacheName: 'sqlite-wasm', expiration: { maxEntries: 6 } },
          },
        ],
      },
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'Tarazu OS',
        short_name: 'Tarazu',
        description: 'Offline-first billing, stock and khata for Indian retail and wholesale',
        theme_color: '#0f766e',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
  // PowerSync / wa-sqlite load their own workers and .wasm via `new URL(..., import.meta.url)`: keep them out of
  // dependency pre-bundling, and build workers as ES modules (they use dynamic import and top-level await).
  optimizeDeps: { exclude: ['@journeyapps/wa-sqlite', '@powersync/web'] },
  worker: { format: 'es' },
  server: {
    // API runs on :8080 in dev; the browser only ever talks to same-origin /api
    proxy: { '/api': { target: 'http://localhost:8080', rewrite: (p) => p.replace(/^\/api/, '') } },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    // e2e/ is Playwright (npm run e2e), not vitest
    exclude: ['e2e/**', 'node_modules/**', 'dist*/**'],
  },
})

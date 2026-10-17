import { defineConfig, devices } from '@playwright/test'

/**
 * Browser tests of the REAL local stack: PowerSync Web SDK + wa-sqlite on OPFS, the built PWA with its service
 * worker, and no backend at all (the sync upload fails quietly, which is the offline case). CI runs
 * `npx playwright install --with-deps chromium` first; in the cloud sandbox Chromium is preinstalled.
 */
const PORT = 4180
export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    launchOptions: { args: ['--no-sandbox'] },
  },
  projects: [
    { name: 'counter-pc', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 720 } } },
    // low-end Android class: small screen, touch, CPU throttling is applied in the perf test itself
    { name: 'android-chrome', use: { ...devices['Pixel 5'] } },
  ],
  webServer: {
    command: `npx vite build --outDir dist-e2e --emptyOutDir && npx vite preview --outDir dist-e2e --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: { VITE_E2E: 'true' },
  },
})

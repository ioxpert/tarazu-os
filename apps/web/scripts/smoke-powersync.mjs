// Smoke test of the REAL local stack (PowerSync Web SDK, wa-sqlite on OPFS, shared worker) in Chromium, with no backend.
// Verifies: the schema loads in real SQLite, the op log writer commits, ops + optimistic effects land in the
// upload queue, the unsent counter counts only operations, writes survive a reload, and local commit latency
// meets the NFR (P95 < 300 ms).
//
// Not part of `npm test` (needs a browser). Usage:  npm run smoke
// Needs the `playwright` package resolvable (it is preinstalled globally in the cloud sandbox; elsewhere
// `npm i -g playwright`) and a Chromium (PLAYWRIGHT_BROWSERS_PATH, or `npx playwright install chromium`).
import { spawn, execSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 4179
const URL_ = `http://localhost:${PORT}/#/dev/sync`
const OUT = 'dist-smoke'
// NFR: invoice commit P95 < 300 ms locally. Override only on a heavily loaded CI box.
const MAX_P95_MS = Number(process.env.SMOKE_MAX_P95_MS ?? 300)

function loadPlaywright() {
  const attempts = [() => createRequire(join(root, 'package.json'))('playwright')]
  attempts.push(() => createRequire(join(execSync('npm root -g').toString().trim(), 'x.js'))('playwright'))
  for (const attempt of attempts) {
    try {
      return attempt()
    } catch {
      /* try next */
    }
  }
  throw new Error('playwright not found: npm i -g playwright')
}

const fail = (msg) => {
  console.error('SMOKE FAIL:', msg)
  process.exitCode = 1
}

execSync(`npx vite build --outDir ${OUT} --emptyOutDir`, { cwd: root, stdio: 'inherit', env: { ...process.env, VITE_ENABLE_DEV_HARNESS: 'true' } })
const server = spawn('npx', ['vite', 'preview', '--outDir', OUT, '--port', String(PORT), '--strictPort'], { cwd: root, stdio: 'ignore' })
await new Promise((r) => setTimeout(r, 2500))

const { chromium } = loadPlaywright()
const browser = await chromium.launch({ args: ['--no-sandbox'] })
try {
  const context = await browser.newContext()
  const page = await context.newPage()
  page.on('pageerror', (e) => console.log('pageerror:', e.message))
  // The production build ships a CSP meta (ADR 0014): any violation while the real stack runs is a failure.
  page.on('console', (m) => {
    if (/Content Security Policy|violates the following/i.test(m.text())) fail(`CSP violation: ${m.text()}`)
  })
  const config = {
    apiBase: '/api',
    deviceToken: 'tzd.11111111-1111-4111-8111-111111111111.a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d.smoke',
    deviceId: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d',
    storeId: '22222222-2222-4222-8222-222222222222',
    tenantId: '11111111-1111-4111-8111-111111111111',
  }
  await page.addInitScript((c) => localStorage.setItem('tarazu.sync.config', JSON.stringify(c)), config)
  await page.goto(URL_)
  await page.waitForSelector('[data-testid=sync-harness]')

  const record = page.getByRole('button', { name: 'Record test sale' })
  await record.waitFor({ state: 'visible' })
  await page.waitForFunction(() => !document.querySelector('fieldset[disabled] button'), null, { timeout: 60_000 })

  await record.click()
  await page.waitForSelector('[data-testid=latency]', { timeout: 60_000 })
  const pending1 = Number(await page.getByTestId('pending').textContent())
  console.log('pending after one sale (2 catalogue + 3 sale ops expected):', pending1)
  if (pending1 !== 5) fail(`expected 5 unsent operations, got ${pending1}`)

  await page.getByRole('button', { name: 'Record 1,000 ops' }).click()
  await page.waitForFunction(() => /334 commits/.test(document.querySelector('[data-testid=latency]')?.textContent ?? ''), null, { timeout: 180_000 })
  const latency = (await page.getByTestId('latency').textContent()) ?? ''
  console.log(latency.trim())
  const p95 = Number(/P95 ([\d.]+) ms/.exec(latency)?.[1])
  if (!(p95 < MAX_P95_MS)) fail(`commit P95 ${p95} ms is not under ${MAX_P95_MS} ms`)
  const pending2 = Number(await page.getByTestId('pending').textContent())
  if (pending2 !== 5 + 334 * 3) fail(`expected ${5 + 334 * 3} unsent operations, got ${pending2}`)

  await page.reload()
  await page.waitForSelector('[data-testid=sync-harness]')
  await page.waitForFunction((n) => Number(document.querySelector('[data-testid=pending]')?.textContent) === n, 5 + 334 * 3, { timeout: 60_000 })
  console.log('unsent operations survived a reload:', 5 + 334 * 3)
  if (process.exitCode !== 1) console.log('SMOKE OK')
} catch (e) {
  fail(e.stack ?? String(e))
} finally {
  await browser.close()
  server.kill()
}

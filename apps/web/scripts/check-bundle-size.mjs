// Fails if the JavaScript needed for first load exceeds 250 KB gzipped (PRD NFR).
// "First load" = every script index.html loads eagerly: <script type="module" src> and <link rel="modulepreload">.
// Lazy chunks (PowerSync, SQLite WASM, the dev harness) are reached only through dynamic import() and do not count.
import { readFileSync, existsSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const LIMIT = 250 * 1024
const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')
const htmlPath = join(dist, 'index.html')
if (!existsSync(htmlPath)) {
  console.error('dist/index.html not found: run `npm run build` first')
  process.exit(2)
}
const html = readFileSync(htmlPath, 'utf8')
const refs = new Set()
for (const m of html.matchAll(/<script\b[^>]*\bsrc="([^"]+\.js)"[^>]*>/g)) refs.add(m[1])
for (const m of html.matchAll(/<link\b[^>]*\brel="modulepreload"[^>]*\bhref="([^"]+\.js)"[^>]*>/g)) refs.add(m[1])
for (const m of html.matchAll(/<link\b[^>]*\bhref="([^"]+\.js)"[^>]*\brel="modulepreload"[^>]*>/g)) refs.add(m[1])

let total = 0
for (const ref of refs) {
  const gz = gzipSync(readFileSync(join(dist, ref.replace(/^\//, '')))).length
  total += gz
  console.log(`${(gz / 1024).toFixed(1).padStart(7)} KB gz  ${ref}`)
}
console.log(`${(total / 1024).toFixed(1).padStart(7)} KB gz  first-load JS total (limit ${LIMIT / 1024} KB)`)
if (refs.size === 0) {
  console.error('no entry scripts found in dist/index.html')
  process.exit(2)
}
if (total > LIMIT) {
  console.error('First-load JS is over budget: lazy-load heavy dependencies (SQLite WASM, voice, charts).')
  process.exit(1)
}

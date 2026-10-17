# ADR 0014: Content-Security-Policy for the web app

Status: accepted (17 Oct 2026)

## Context
The web client keeps device and session bearer tokens in `localStorage` (ADR 0004/0007) and signs and queues money
operations. Any injected script could read them. Moving tokens out of `localStorage` does not help much in an offline
PWA that must work without a server round trip; stopping script injection does.

## Decision
- Production builds embed a CSP `<meta>` (`apps/web/csp.ts`, injected by a Vite plugin; not in dev, where HMR needs
  inline scripts). Policy: `default-src 'none'`; scripts same-origin only with `'wasm-unsafe-eval'` (SQLite and zxing
  WASM) and no `unsafe-inline`/`unsafe-eval`; workers `self` + `blob:`; `object-src 'none'`; `base-uri`/`form-action` self.
- `style-src` keeps `'unsafe-inline'`: the receipt print iframe (`srcdoc`) carries an inline `<style>` and inherits
  the policy. Style injection cannot run code, so this is accepted.
- `connect-src` is `'self'` plus the PowerSync service origin, which is deployment config:
  build with `VITE_CSP_CONNECT="https://sync.example.in"` (space or comma separated, https/wss origins only, no
  wildcards; the build fails on anything else). The API is same-origin.
- The smoke test (`npm run smoke`, real wa-sqlite/OPFS in Chromium) runs against the production build and fails on
  any CSP violation, so a new dependency that needs eval or a CDN is caught.

## Also serve as headers
A `<meta>` policy cannot express `frame-ancestors` and applies only after the HTML is parsed. Whoever serves the
static files should also send the same policy as a response header plus `frame-ancestors 'none'`,
`X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`. The service worker script and the manifest must
be served same-origin and not cached beyond a day. (No hosting is chosen yet; this is the checklist for it.)

## Not done
- Hosting headers themselves (no deploy target yet).
- Report-only endpoint: add `report-to` once there is somewhere to receive reports.

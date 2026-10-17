/**
 * Content-Security-Policy for the built app (ADR 0014). Scripts are same-origin only; the only relaxations are what the
 * local database needs (`wasm-unsafe-eval` for SQLite/zxing WASM, `blob:` workers) and inline styles (React style
 * props and the receipt print iframe, which inherits this policy through `srcdoc`).
 *
 * `connectOrigins` are the extra origins the browser may call: in practice the PowerSync service URL that
 * `/v1/sync/credentials` returns (build with VITE_CSP_CONNECT="https://sync.example.in"). The API is same-origin.
 */
export function buildCsp(connectOrigins: string[] = []): string {
  for (const o of connectOrigins) {
    if (!/^(https|wss):\/\/[a-z0-9.-]+(:\d+)?$/i.test(o)) throw new Error(`invalid CSP connect origin: ${o}`)
  }
  const directives: Record<string, string[]> = {
    'default-src': ["'none'"],
    'script-src': ["'self'", "'wasm-unsafe-eval'"],
    'worker-src': ["'self'", 'blob:'],
    'connect-src': ["'self'", ...connectOrigins],
    'img-src': ["'self'", 'data:', 'blob:'],
    'media-src': ["'self'", 'blob:'],
    'style-src': ["'self'", "'unsafe-inline'"],
    'font-src': ["'self'"],
    'manifest-src': ["'self'"],
    'frame-src': ["'self'", 'about:'],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
  }
  return Object.entries(directives)
    .map(([k, v]) => `${k} ${v.join(' ')}`)
    .join('; ')
}

/** Directives a `<meta>` policy ignores; serve these as real response headers (see ADR 0014). */
export const HEADER_ONLY = "frame-ancestors 'none'"

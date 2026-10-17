import { buildCsp } from '../csp'

describe('buildCsp', () => {
  it('is same-origin only for scripts and denies everything not listed', () => {
    const csp = buildCsp()
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'")
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/)
    expect(csp).not.toMatch(/script-src[^;]*unsafe-eval(?!')/)
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("connect-src 'self'")
  })

  it('adds the sync service origin to connect-src only', () => {
    const csp = buildCsp(['https://sync.example.in', 'wss://sync.example.in:8443'])
    expect(csp).toContain("connect-src 'self' https://sync.example.in wss://sync.example.in:8443")
    expect(csp).not.toMatch(/script-src[^;]*example/)
  })

  it('rejects anything that is not a plain https/wss origin (no wildcards, schemes or paths)', () => {
    for (const bad of ['*', 'http://x.in', 'https://x.in/path', "https://x.in; script-src *", 'https://*.x.in', 'data:'])
      expect(() => buildCsp([bad])).toThrow()
  })
})

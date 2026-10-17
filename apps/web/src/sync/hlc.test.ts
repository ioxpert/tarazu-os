import { describe, expect, it } from 'vitest'
import { compare, format, nodeIdOf, parse, receive, tick } from './hlc'

const NODE = 'a1b2c3d4'
const T0 = Date.parse('2026-10-17T10:00:00.000Z')

describe('hlc', () => {
  it('formats exactly like the server', () => {
    expect(format({ ms: T0, counter: 0, node: NODE })).toBe('2026-10-17T10:00:00.000Z-0000-a1b2c3d4')
    expect(format({ ms: T0, counter: 255, node: NODE })).toBe('2026-10-17T10:00:00.000Z-00ff-a1b2c3d4')
  })

  it('round-trips through parse', () => {
    const h = { ms: T0 + 123, counter: 4660, node: NODE }
    expect(parse(format(h))).toEqual(h)
    expect(() => parse('yesterday')).toThrow()
  })

  it('derives the node from the device id', () => {
    expect(nodeIdOf('a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d')).toBe('a1b2c3d4')
  })

  it('advances with the wall clock and counts within one millisecond', () => {
    const a = tick(null, T0, NODE)
    const b = tick(a, T0, NODE)
    const c = tick(b, T0 + 5, NODE)
    expect(b).toMatchObject({ ms: T0, counter: 1 })
    expect(c).toMatchObject({ ms: T0 + 5, counter: 0 })
  })

  it('stays monotonic when the wall clock goes backwards', () => {
    let h = tick(null, T0, NODE)
    const seen = [h]
    for (const wall of [T0 - 60_000, T0 - 60_000, T0 - 1, T0, T0 + 1]) {
      h = tick(h, wall, NODE)
      seen.push(h)
    }
    for (let i = 1; i < seen.length; i++) expect(compare(seen[i - 1], seen[i])).toBeLessThan(0)
  })

  it('borrows a millisecond instead of wrapping a saturated counter', () => {
    const next = tick({ ms: T0, counter: 0xffff, node: NODE }, T0 - 1, NODE)
    expect(next).toEqual({ ms: T0 + 1, counter: 0, node: NODE })
  })

  it('receive moves past both the local and the remote clock', () => {
    const local = { ms: T0, counter: 3, node: NODE }
    const remote = { ms: T0 + 10_000, counter: 7, node: 'ffffffff' }
    const r = receive(local, remote, T0 + 1)
    expect(compare(r, remote)).toBeGreaterThan(0)
    expect(compare(r, local)).toBeGreaterThan(0)
    expect(r.node).toBe(NODE)
    expect(receive(local, remote, T0 + 99_999)).toEqual({ ms: T0 + 99_999, counter: 0, node: NODE })
  })

  it('orders by time, then counter, then node', () => {
    expect(compare({ ms: 1, counter: 9, node: 'b' }, { ms: 2, counter: 0, node: 'a' })).toBeLessThan(0)
    expect(compare({ ms: 1, counter: 1, node: 'b' }, { ms: 1, counter: 0, node: 'a' })).toBeGreaterThan(0)
    expect(compare({ ms: 1, counter: 1, node: 'a' }, { ms: 1, counter: 1, node: 'b' })).toBeLessThan(0)
  })
})

/**
 * Hybrid logical clock, byte-for-byte the server's format (services/api syncgateway.Hlc):
 * `2026-10-17T10:00:00.000Z-0000-a1b2c3d4` = UTC millis, 4-hex counter, node id (first 8 hex of the device id).
 * Orders by time, then counter, then node, so two writes never tie and a late write never overwrites a newer one.
 */
export interface Hlc {
  ms: number
  counter: number
  node: string
}

const MAX_COUNTER = 0xffff
const PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)-([0-9a-fA-F]{4})-([A-Za-z0-9]{1,16})$/

export function nodeIdOf(deviceId: string): string {
  return deviceId.replace(/-/g, '').slice(0, 8)
}

export function format(h: Hlc): string {
  return `${new Date(h.ms).toISOString()}-${h.counter.toString(16).padStart(4, '0')}-${h.node}`
}

export function parse(raw: string): Hlc {
  const m = PATTERN.exec(raw)
  if (!m) throw new Error(`Malformed HLC: ${raw}`)
  return { ms: Date.parse(m[1]), counter: parseInt(m[2], 16), node: m[3] }
}

export function compare(a: Hlc, b: Hlc): number {
  return a.ms - b.ms || a.counter - b.counter || (a.node < b.node ? -1 : a.node > b.node ? 1 : 0)
}

function withCounter(ms: number, counter: number, node: string): Hlc {
  // a saturated counter borrows the next millisecond instead of wrapping (which would go backwards)
  return counter > MAX_COUNTER ? { ms: ms + 1, counter: 0, node } : { ms, counter, node }
}

/** Next timestamp for a local event. Strictly greater than `prev` even if the wall clock stepped back. */
export function tick(prev: Hlc | null, wallMs: number, node: string): Hlc {
  if (!prev || wallMs > prev.ms) return { ms: wallMs, counter: 0, node }
  return withCounter(prev.ms, prev.counter + 1, node)
}

/** Next timestamp after observing a remote one (keeps causality across devices). */
export function receive(prev: Hlc, remote: Hlc, wallMs: number): Hlc {
  const ms = Math.max(prev.ms, remote.ms, wallMs)
  if (ms === wallMs && wallMs > prev.ms && wallMs > remote.ms) return { ms, counter: 0, node: prev.node }
  const counter =
    ms === prev.ms && ms === remote.ms
      ? Math.max(prev.counter, remote.counter) + 1
      : ms === prev.ms
        ? prev.counter + 1
        : remote.counter + 1
  return withCounter(ms, counter, prev.node)
}

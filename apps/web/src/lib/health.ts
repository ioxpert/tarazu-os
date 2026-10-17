import type { components } from '../api/schema'

export type Health = components['schemas']['Health']

export async function fetchApiHealth(signal?: AbortSignal): Promise<Health['status']> {
  const res = await fetch('/api/actuator/health', { signal })
  if (!res.ok) throw new Error(`health ${res.status}`)
  return ((await res.json()) as Health).status
}

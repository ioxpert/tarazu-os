import type { components } from './schema'

export type UploadRequest = components['schemas']['UploadRequest']
export type UploadResponse = components['schemas']['UploadResponse']

/** Typed upload call; the PowerSync connector's uploadData() will use this in the sync PR. */
export async function uploadOperations(body: UploadRequest, token: string): Promise<UploadResponse> {
  const res = await fetch('/api/v1/sync/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`upload ${res.status}`)
  return (await res.json()) as UploadResponse
}

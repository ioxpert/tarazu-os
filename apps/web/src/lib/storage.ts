export interface StorageStatus {
  supported: boolean
  persisted: boolean
  usageMb: number
  quotaMb: number
}

const MB = 1024 * 1024

/**
 * Browser storage is the system of record for offline billing, so we ask the browser to make it
 * persistent (not evictable) and surface the result. Eviction risk is tracked in the PRD risk register.
 */
export async function requestPersistence(): Promise<StorageStatus> {
  const storage = typeof navigator !== 'undefined' ? navigator.storage : undefined
  if (!storage || typeof storage.persist !== 'function') {
    return { supported: false, persisted: false, usageMb: 0, quotaMb: 0 }
  }
  const persisted = (await storage.persisted()) || (await storage.persist())
  const estimate = storage.estimate ? await storage.estimate() : {}
  return {
    supported: true,
    persisted,
    usageMb: Math.round((estimate.usage ?? 0) / MB),
    quotaMb: Math.round((estimate.quota ?? 0) / MB),
  }
}

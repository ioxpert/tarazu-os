import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestPersistence } from './storage'

afterEach(() => vi.unstubAllGlobals())

function stubStorage(storage: Partial<StorageManager> | undefined) {
  vi.stubGlobal('navigator', { storage })
}

describe('requestPersistence', () => {
  it('reports unsupported when the browser has no StorageManager', async () => {
    stubStorage(undefined)
    expect(await requestPersistence()).toMatchObject({ supported: false, persisted: false })
  })

  it('asks for persistence when not yet granted and reports usage in MB', async () => {
    const persist = vi.fn().mockResolvedValue(true)
    stubStorage({
      persisted: vi.fn().mockResolvedValue(false),
      persist,
      estimate: vi.fn().mockResolvedValue({ usage: 5 * 1024 * 1024, quota: 100 * 1024 * 1024 }),
    })
    expect(await requestPersistence()).toEqual({ supported: true, persisted: true, usageMb: 5, quotaMb: 100 })
    expect(persist).toHaveBeenCalledOnce()
  })

  it('does not re-request when already persistent', async () => {
    const persist = vi.fn()
    stubStorage({ persisted: vi.fn().mockResolvedValue(true), persist, estimate: vi.fn().mockResolvedValue({}) })
    expect((await requestPersistence()).persisted).toBe(true)
    expect(persist).not.toHaveBeenCalled()
  })
})

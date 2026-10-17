import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'UP' }) }))
  Object.defineProperty(navigator, 'storage', {
    configurable: true,
    value: {
      persisted: vi.fn().mockResolvedValue(true),
      persist: vi.fn(),
      estimate: vi.fn().mockResolvedValue({ usage: 1048576, quota: 104857600 }),
    },
  })
})
afterEach(() => vi.unstubAllGlobals())

describe('App', () => {
  it('shows the product name and live system status', async () => {
    render(<App />)
    expect(screen.getByRole('heading', { name: 'Tarazu OS' })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText(/persistent \(1 MB of 100 MB\)/)).toBeInTheDocument())
    await waitFor(() => expect(screen.getByText('up')).toBeInTheDocument())
  })
})

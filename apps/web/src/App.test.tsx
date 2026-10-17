import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { App } from './App'
import { initI18n } from './i18n'

beforeAll(async () => {
  await initI18n()
})
afterEach(() => localStorage.clear())

describe('App', () => {
  it('asks an unlinked device for its device code, and nothing else needs the network', async () => {
    render(<App />)
    expect(await screen.findByTestId('setup-screen')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Connect this device' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled()
    await userEvent.type(screen.getByTestId('setup-token'), 'tzd.x')
    expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled()
  })
})

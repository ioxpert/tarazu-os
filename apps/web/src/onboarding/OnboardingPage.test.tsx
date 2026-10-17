import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '../auth/api'
import { loadSession, saveSession } from '../auth/session'
import { loadSyncConfig } from '../sync/config'
import OnboardingPage from './OnboardingPage'

type Handler = (body: Record<string, unknown>, init: RequestInit) => { status?: number; body?: unknown }

function mockApi(routes: Record<string, Handler>) {
  const calls: { path: string; body: Record<string, unknown>; auth?: string }[] = []
  const fetchImpl = vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = `${init.method ?? 'GET'} ${url.replace('/api', '')}`
    const body = init.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {}
    calls.push({ path, body, auth: (init.headers as Record<string, string> | undefined)?.Authorization })
    const route = Object.entries(routes).find(([k]) => path.startsWith(k))
    if (!route) return new Response('{}', { status: 404 })
    const out = route[1](body, init)
    const status = out.status ?? 200
    return new Response(status === 204 ? null : JSON.stringify(out.body ?? {}), { status })
  })
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls }
}

const config = (over: Record<string, unknown>) => ({
  enabled: true,
  mode: 'either',
  channels: ['email', 'phone'],
  signupRequires: [],
  codeTtlMinutes: 10,
  resendSeconds: 60,
  ...over,
})

const session = (over: Partial<Session> = {}): Session => ({
  token: 'tzs.t.s.x',
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  tenantId: '00000000-0000-7000-8000-000000000001',
  userId: '00000000-0000-7000-8000-000000000004',
  roles: ['owner'],
  ...over,
})

const challenge = (channel: string, sentTo: string) => ({
  channel,
  sentTo,
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  resendAfter: new Date(Date.now() + 60_000).toISOString(),
})

function renderPage(routes: Record<string, Handler>) {
  const api = mockApi(routes)
  render(<OnboardingPage fetchImpl={api.fetchImpl} />)
  return api
}

beforeEach(() => localStorage.clear())
afterEach(() => vi.useRealTimers())

describe('config-driven fields', () => {
  const cases: [string, string[], string[], boolean, boolean][] = [
    ['email', ['email'], ['email'], true, false],
    ['phone', ['phone'], ['phone'], false, true],
    ['either', ['email', 'phone'], [], true, true],
    ['both', ['email', 'phone'], ['email', 'phone'], true, true],
  ]
  it.each(cases)('mode %s', async (mode, channels, signupRequires, email, phone) => {
    renderPage({ 'GET /v1/auth/otp/config': () => ({ body: config({ mode, channels, signupRequires }) }) })
    await screen.findByLabelText(/your name/i)
    expect(!!screen.queryByLabelText(/^email/i)).toBe(email)
    expect(!!screen.queryByLabelText(/^phone/i)).toBe(phone)
    if (mode === 'both') {
      expect(screen.getByLabelText(/^email/i)).toBeRequired()
      expect(screen.getByLabelText(/^phone/i)).toBeRequired()
    }
    if (mode === 'either') expect(screen.getByLabelText(/^email/i)).not.toBeRequired()
  })

  it('says so when sign-in is not configured', async () => {
    renderPage({ 'GET /v1/auth/otp/config': () => ({ body: config({ enabled: false }) }) })
    expect(await screen.findByText(/not configured on this server/i)).toBeInTheDocument()
  })
})

describe('sign-up', () => {
  const both = {
    'GET /v1/auth/otp/config': () => ({ body: config({ mode: 'both', signupRequires: ['email', 'phone'] }) }),
    'POST /v1/auth/signup/start': () => ({ status: 202, body: { signupToken: 'tok.1', challenges: [challenge('email', 'a***@x.in'), challenge('phone', '+91*******10')] } }),
  }

  async function fillDetails() {
    fireEvent.change(await screen.findByLabelText(/your name/i), { target: { value: 'Asha' } })
    fireEvent.change(screen.getByLabelText(/business name/i), { target: { value: 'Rao Stores' } })
    fireEvent.change(screen.getByLabelText(/^email/i), { target: { value: 'a@x.in' } })
    fireEvent.change(screen.getByLabelText(/^phone/i), { target: { value: '9876543210' } })
    fireEvent.click(screen.getByRole('button', { name: /send codes/i }))
  }

  it('verifies both contacts, saves the session and sets up the device', async () => {
    let verified = 0
    const api = renderPage({
      ...both,
      'POST /v1/auth/signup/verify': () =>
        ++verified === 1
          ? { body: { status: 'pending', remainingChannels: ['phone'] } }
          : { body: { status: 'completed', remainingChannels: [], session: session(), businessId: 'b', storeId: '00000000-0000-7000-8000-000000000003' } },
      'PUT /v1/identity/devices/': () => ({ status: 201, body: { id: 'd', storeId: 's', token: 'tzd.00000000-0000-7000-8000-000000000001.00000000-0000-7000-8000-0000000000dd.secret' } }),
    })
    await fillDetails()
    const email = await screen.findByLabelText(/code sent to a\*\*\*@x.in/i)
    expect(email).toHaveFocus()
    expect(email).toHaveAttribute('autocomplete', 'one-time-code')
    expect(email).toHaveAttribute('inputmode', 'numeric')
    fireEvent.change(email, { target: { value: '123456' } })
    fireEvent.click(screen.getByRole('button', { name: /confirm email/i }))
    await screen.findByText(/email confirmed/i)
    expect(screen.queryByLabelText(/a\*\*\*@x.in/i)).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/code sent to \+91/i), { target: { value: '654321' } })
    fireEvent.click(screen.getByRole('button', { name: /confirm phone/i }))

    await screen.findByText(/you are signed in/i)
    expect(loadSession()?.token).toBe('tzs.t.s.x')
    expect(api.calls.find((c) => c.path.startsWith('POST /v1/auth/signup/start'))?.body).toMatchObject({ email: 'a@x.in', phone: '9876543210' })
    expect(api.calls.find((c) => c.path.startsWith('POST /v1/auth/signup/start'))?.auth).toBeUndefined()

    fireEvent.click(screen.getByRole('button', { name: /set up this device/i }))
    await screen.findByText(/this device is set up/i)
    const reg = api.calls.find((c) => c.path.startsWith('PUT /v1/identity/devices/'))!
    expect(reg.auth).toBe('Bearer tzs.t.s.x')
    expect(reg.body).toMatchObject({ storeId: '00000000-0000-7000-8000-000000000003' })
    expect(loadSyncConfig()).toMatchObject({ deviceToken: expect.stringMatching(/^tzd\./), storeId: '00000000-0000-7000-8000-000000000003' })
  })

  it.each([
    ['invalid_code', 401, /not right/i],
    ['code_expired', 410, /expired/i],
    ['too_many_attempts', 429, /too many wrong codes/i],
  ])('shows a clear message for %s', async (code, status, text) => {
    renderPage({ ...both, 'POST /v1/auth/signup/verify': () => ({ status, body: { code, detail: 'x' } }) })
    await fillDetails()
    fireEvent.change(await screen.findByLabelText(/code sent to a\*\*\*@x.in/i), { target: { value: '111111' } })
    fireEvent.click(screen.getByRole('button', { name: /confirm email/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(text)
  })

  it('counts down before a code can be sent again, then resends', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const api = renderPage({ ...both, 'POST /v1/auth/signup/resend': () => ({ status: 202 }) })
    await fillDetails()
    const resend = await screen.findAllByRole('button', { name: /send again in \d+s/i })
    expect(resend[0]).toBeDisabled()
    await act(async () => {
      vi.advanceTimersByTime(61_000)
    })
    const ready = await screen.findAllByRole('button', { name: /send a new code/i })
    fireEvent.click(ready[0])
    await waitFor(() => expect(api.calls.some((c) => c.path.startsWith('POST /v1/auth/signup/resend'))).toBe(true))
    expect(await screen.findAllByRole('button', { name: /send again in \d+s/i })).toHaveLength(1) // only the resent contact restarts its countdown
  })

  it('shows the already-have-an-account message', async () => {
    renderPage({ ...both, 'POST /v1/auth/signup/start': () => ({ status: 409, body: { code: 'contact_in_use', detail: 'x' } }) })
    await fillDetails()
    expect(await screen.findByRole('alert')).toHaveTextContent(/already has an account/i)
  })

  it('either mode needs at least one contact', async () => {
    const api = renderPage({ 'GET /v1/auth/otp/config': () => ({ body: config({}) }) })
    fireEvent.change(await screen.findByLabelText(/your name/i), { target: { value: 'A' } })
    fireEvent.change(screen.getByLabelText(/business name/i), { target: { value: 'B' } })
    fireEvent.click(screen.getByRole('button', { name: /send code/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/email, a phone number, or both/i)
    expect(api.calls.some((c) => c.path.includes('signup/start'))).toBe(false)
  })
})

describe('sign-in and sign-out', () => {
  it('signs in with a code on an enabled channel, then signs out', async () => {
    const api = renderPage({
      'GET /v1/auth/otp/config': () => ({ body: config({ mode: 'phone', channels: ['phone'] }) }),
      'POST /v1/auth/login/start': () => ({ status: 202, body: { challengeToken: 'c.1', expiresAt: new Date(Date.now() + 600_000).toISOString(), resendAfter: new Date(Date.now() + 60_000).toISOString() } }),
      'POST /v1/auth/login/verify': () => ({ body: session() }),
      'POST /v1/auth/logout': () => ({ status: 204 }),
    })
    fireEvent.click(await screen.findByRole('tab', { name: /^sign in$/i }))
    expect(screen.queryByLabelText(/sign in with/i)).not.toBeInTheDocument() // only one channel enabled
    fireEvent.change(screen.getByLabelText(/^phone/i), { target: { value: '9876543210' } })
    fireEvent.click(screen.getByRole('button', { name: /send code/i }))
    const code = await screen.findByLabelText(/6-digit code/i)
    expect(code).toHaveFocus()
    fireEvent.change(code, { target: { value: '123456' } })
    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }))
    await screen.findByText(/you are signed in/i)
    expect(screen.getByText(/owner/)).toBeInTheDocument()
    expect(loadSession()).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /sign out/i }))
    await screen.findByLabelText(/your name/i)
    expect(loadSession()).toBeNull()
    expect(api.calls.find((c) => c.path.startsWith('POST /v1/auth/logout'))?.auth).toBe('Bearer tzs.t.s.x')
  })

  it('an expired stored session counts as signed out', async () => {
    saveSession(session({ expiresAt: new Date(Date.now() - 1000).toISOString() }))
    expect(loadSession()).toBeNull()
    renderPage({ 'GET /v1/auth/otp/config': () => ({ body: config({}) }) })
    expect(await screen.findByLabelText(/your name/i)).toBeInTheDocument()
  })

  it('a valid stored session opens the signed-in view without asking again', async () => {
    saveSession(session())
    renderPage({ 'GET /v1/auth/otp/config': () => ({ body: config({}) }) })
    expect(await screen.findByText(/you are signed in/i)).toBeInTheDocument()
  })
})

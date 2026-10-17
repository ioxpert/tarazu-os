import type { components } from '../api/schema'

type S = components['schemas']

export type OtpConfig = S['OtpConfig']
export type SignupStarted = S['SignupStarted']
export type SignupProgress = S['SignupProgress']
export type LoginStarted = S['LoginStarted']
export type Session = S['Session']
export type Channel = 'email' | 'phone'

/** A server refusal. `code` is the stable problem+json code (invalid_code, code_expired, too_many_attempts, ...). */
export class ApiProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail: string,
  ) {
    super(detail)
  }
}

export const DEFAULT_API_BASE = '/api'

async function call<T>(
  base: string,
  method: string,
  path: string,
  opts: { body?: unknown; token?: string; fetchImpl?: typeof fetch } = {},
): Promise<T> {
  const headers: Record<string, string> = {}
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`
  const doFetch = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a))
  const res = await doFetch(`${base}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  if (!res.ok) {
    let problem: { code?: string; detail?: string } = {}
    try {
      problem = (await res.json()) as typeof problem
    } catch {
      /* not json */
    }
    throw new ApiProblem(res.status, problem.code ?? String(res.status), problem.detail ?? `Request failed (${res.status})`)
  }
  if (res.status === 204 || res.status === 202) {
    const text = await res.text().catch(() => '')
    return (text ? JSON.parse(text) : undefined) as T
  }
  return (await res.json()) as T
}

/** Public onboarding/login calls (no credential) and the two session-authenticated ones. */
export function authApi(base: string = DEFAULT_API_BASE, fetchImpl?: typeof fetch) {
  const f = { fetchImpl }
  return {
    config: () => call<OtpConfig>(base, 'GET', '/v1/auth/otp/config', f),
    startSignup: (body: components['schemas']['SignupStartRequest']) =>
      call<SignupStarted>(base, 'POST', '/v1/auth/signup/start', { ...f, body }),
    verifySignup: (signupToken: string, channel: Channel, code: string) =>
      call<SignupProgress>(base, 'POST', '/v1/auth/signup/verify', { ...f, body: { signupToken, channel, code } }),
    resendSignup: (signupToken: string, channel: Channel) =>
      call<void>(base, 'POST', '/v1/auth/signup/resend', { ...f, body: { signupToken, channel } }),
    startLogin: (channel: Channel, contact: string) =>
      call<LoginStarted>(base, 'POST', '/v1/auth/login/start', { ...f, body: { channel, contact } }),
    verifyLogin: (challengeToken: string, code: string) =>
      call<Session>(base, 'POST', '/v1/auth/login/verify', { ...f, body: { challengeToken, code } }),
    logout: (token: string) => call<void>(base, 'POST', '/v1/auth/logout', { ...f, token }),
    registerDevice: (token: string, deviceId: string, storeId: string, label: string) =>
      call<components['schemas']['DeviceRegistered']>(base, 'PUT', `/v1/identity/devices/${deviceId}`, {
        ...f,
        token,
        body: { storeId, label },
      }),
  }
}

/** Plain-English message for a problem code. */
export function messageFor(p: unknown): string {
  if (!(p instanceof ApiProblem)) return 'Could not reach the server. Check your connection and try again.'
  switch (p.code) {
    case 'invalid_code':
      return 'That code is not right. Check it and try again.'
    case 'code_expired':
      return 'That code has expired. Ask for a new one.'
    case 'too_many_attempts':
      return 'Too many wrong codes. Ask for a new one.'
    case 'resend_too_soon':
      return 'Please wait a moment before asking for another code.'
    case 'too_many_requests':
      return 'Too many codes requested for this contact. Try again later.'
    case 'contact_in_use':
      return 'That email or phone already has an account. Sign in instead.'
    case 'contact_required':
      return 'Please enter the email or phone number this server needs.'
    case 'invalid_contact':
      return 'That email or phone number does not look right.'
    case 'otp_not_configured':
    case 'otp_channel_unavailable':
      return 'Sign-in is not configured on this server.'
    case 'otp_delivery_failed':
      return 'We could not send the code. Try again shortly.'
    case 'signup_closed':
    case 'signup_not_found':
    case 'token_invalid':
      return 'This sign-up has expired. Please start again.'
    default:
      return p.detail || 'Something went wrong. Please try again.'
  }
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiProblem, authApi, messageFor, type Channel, type OtpConfig, type Session } from '../auth/api'
import { clearSession, loadSession, saveSession } from '../auth/session'
import { saveSyncConfig } from '../sync/config'
import { uuidv7 } from '../sync/uuid7'

const LABEL: Record<Channel, string> = { email: 'Email', phone: 'Phone' }

type Step = 'loading' | 'details' | 'codes' | 'signin-contact' | 'signin-code' | 'done'

function useCountdown(until: number | null) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (until === null) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [until])
  return until === null ? 0 : Math.max(0, Math.ceil((until - now) / 1000))
}

function ResendButton({ resendAfter, onResend }: { resendAfter: number | null; onResend: () => void }) {
  const left = useCountdown(resendAfter)
  return (
    <button type="button" onClick={onResend} disabled={left > 0}>
      {left > 0 ? `Send again in ${left}s` : 'Send a new code'}
    </button>
  )
}

export interface OnboardingPageProps {
  apiBase?: string
  fetchImpl?: typeof fetch
}

export default function OnboardingPage({ apiBase = '/api', fetchImpl }: OnboardingPageProps) {
  const api = useMemo(() => authApi(apiBase, fetchImpl), [apiBase, fetchImpl])
  const [config, setConfig] = useState<OtpConfig | null>(null)
  const [session, setSession] = useState<Session | null>(() => loadSession())
  const [tab, setTab] = useState<'signup' | 'signin'>('signup')
  const [step, setStep] = useState<Step>(() => (loadSession() ? 'done' : 'loading'))
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [ownerName, setOwnerName] = useState('')
  const [businessName, setBusinessName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')

  const [signupToken, setSignupToken] = useState('')
  const [pending, setPending] = useState<Channel[]>([])
  const [codes, setCodes] = useState<Record<string, string>>({})
  const [resendAt, setResendAt] = useState<Record<string, number>>({})
  const [sentTo, setSentTo] = useState<Record<string, string>>({})

  const [loginChannel, setLoginChannel] = useState<Channel>('email')
  const [loginContact, setLoginContact] = useState('')
  const [loginToken, setLoginToken] = useState('')
  const [loginCode, setLoginCode] = useState('')
  const [loginResendAt, setLoginResendAt] = useState<number | null>(null)

  const [deviceMsg, setDeviceMsg] = useState<string | null>(null)
  const [storeId, setStoreId] = useState<string | null>(null)
  const codeRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    api
      .config()
      .then((c) => {
        setConfig(c)
        setLoginChannel(c.channels.includes('email') ? 'email' : 'phone')
        setStep((s) => (s === 'loading' ? 'details' : s))
      })
      .catch((e) => {
        setError(messageFor(e))
        setStep((s) => (s === 'loading' ? 'details' : s))
      })
  }, [api])

  useEffect(() => {
    if (step === 'codes' || step === 'signin-code') codeRef.current?.focus()
  }, [step])

  const showEmail = !!config && config.channels.includes('email')
  const showPhone = !!config && config.channels.includes('phone')
  const required = new Set(config?.signupRequires ?? [])
  const mode = config?.mode

  const run = useCallback(async (work: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    setInfo(null)
    try {
      await work()
    } catch (e) {
      setError(messageFor(e))
      if (e instanceof ApiProblem && (e.code === 'signup_closed' || e.code === 'signup_not_found' || e.code === 'token_invalid')) {
        setStep('details')
      }
    } finally {
      setBusy(false)
    }
  }, [])

  const startSignup = (ev: React.FormEvent) => {
    ev.preventDefault()
    if (mode === 'either' && !email.trim() && !phone.trim()) {
      setError('Enter an email, a phone number, or both.')
      return
    }
    void run(async () => {
      const started = await api.startSignup({
        ownerName,
        businessName,
        email: showEmail && email.trim() ? email.trim() : null,
        phone: showPhone && phone.trim() ? phone.trim() : null,
      })
      setSignupToken(started.signupToken)
      setPending(started.challenges.map((c) => c.channel))
      setResendAt(Object.fromEntries(started.challenges.map((c) => [c.channel, Date.parse(c.resendAfter)])))
      setSentTo(Object.fromEntries(started.challenges.map((c) => [c.channel, c.sentTo])))
      setCodes({})
      setStep('codes')
    })
  }

  const verify = (channel: Channel) => {
    void run(async () => {
      const progress = await api.verifySignup(signupToken, channel, codes[channel] ?? '')
      if (progress.status === 'completed' && progress.session) {
        saveSession(progress.session)
        setSession(progress.session)
        setStoreId(progress.storeId ?? null)
        setStep('done')
      } else {
        setPending(progress.remainingChannels)
        setInfo(`${LABEL[channel]} confirmed.`)
      }
    })
  }

  const resend = (channel: Channel) => {
    void run(async () => {
      await api.resendSignup(signupToken, channel)
      setResendAt((r) => ({ ...r, [channel]: Date.now() + (config?.resendSeconds ?? 60) * 1000 }))
      setInfo(`A new code was sent to your ${channel}.`)
    })
  }

  const startLogin = (ev: React.FormEvent) => {
    ev.preventDefault()
    void run(async () => {
      const started = await api.startLogin(loginChannel, loginContact)
      setLoginToken(started.challengeToken)
      setLoginResendAt(Date.parse(started.resendAfter))
      setLoginCode('')
      setStep('signin-code')
    })
  }

  const finishLogin = (ev: React.FormEvent) => {
    ev.preventDefault()
    void run(async () => {
      const s = await api.verifyLogin(loginToken, loginCode)
      saveSession(s)
      setSession(s)
      setStep('done')
    })
  }

  const setUpDevice = () => {
    if (!session) return
    void run(async () => {
      const store = storeId
      if (!store) throw new ApiProblem(0, 'no_store', 'Open the sign-up on the device that created the account to set it up.')
      const deviceId = uuidv7()
      const reg = await api.registerDevice(session.token, deviceId, store, 'This device')
      if (!reg.token) throw new ApiProblem(0, 'no_token', 'The server did not return a device token.')
      saveSyncConfig({ apiBase, deviceToken: reg.token, deviceId, storeId: store, tenantId: session.tenantId, actorUserId: session.userId })
      setDeviceMsg('This device is set up. It will start saving and backing up your sales.')
    })
  }

  const signOut = () => {
    const token = session?.token
    void run(async () => {
      try {
        if (token) await api.logout(token)
      } finally {
        clearSession()
        setSession(null)
        setTab('signup')
        setStep('details')
        setDeviceMsg(null)
      }
    })
  }

  // a stored session may expire while the page is open
  useEffect(() => {
    if (!session) return
    const ms = Date.parse(session.expiresAt) - Date.now()
    const t = setTimeout(() => {
      clearSession()
      setSession(null)
      setTab('signin')
      setStep('signin-contact')
      setError('Your session has expired. Please sign in again.')
    }, Math.min(Math.max(ms, 0), 2 ** 31 - 1))
    return () => clearTimeout(t)
  }, [session])

  if (step === 'loading') return <main className="shell"><p>Loading…</p></main>

  if (config && !config.enabled && !session) {
    return (
      <main className="shell">
        <h1>Sign in</h1>
        <p role="alert">Sign-in is not configured on this server.</p>
      </main>
    )
  }

  if (step === 'done' && session) {
    return (
      <main className="shell">
        <h1>You are signed in</h1>
        <p>
          Account <code>{session.tenantId}</code> · {session.roles.join(', ')}
        </p>
        {storeId && !deviceMsg && (
          <p>
            <button type="button" onClick={setUpDevice} disabled={busy}>
              Set up this device
            </button>
          </p>
        )}
        {deviceMsg && <p role="status">{deviceMsg}</p>}
        <p role="alert" aria-live="assertive">{error}</p>
        <button type="button" onClick={signOut} disabled={busy}>
          Sign out
        </button>
      </main>
    )
  }

  return (
    <main className="shell">
      <h1>{tab === 'signup' ? 'Create your account' : 'Sign in'}</h1>
      <div role="tablist" aria-label="Account">
        <button role="tab" type="button" aria-selected={tab === 'signup'} onClick={() => { setTab('signup'); setStep('details'); setError(null) }}>
          Create account
        </button>{' '}
        <button role="tab" type="button" aria-selected={tab === 'signin'} onClick={() => { setTab('signin'); setStep('signin-contact'); setError(null) }}>
          Sign in
        </button>
      </div>

      {tab === 'signup' && step === 'details' && (
        <form onSubmit={startSignup}>
          <p>
            <label>
              Your name
              <input value={ownerName} onChange={(e) => setOwnerName(e.target.value)} required autoComplete="name" />
            </label>
          </p>
          <p>
            <label>
              Shop or business name
              <input value={businessName} onChange={(e) => setBusinessName(e.target.value)} required autoComplete="organization" />
            </label>
          </p>
          {showEmail && (
            <p>
              <label>
                Email{required.has('email') ? '' : mode === 'either' ? ' (optional if you give a phone)' : ''}
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required={required.has('email')} autoComplete="email" />
              </label>
            </p>
          )}
          {showPhone && (
            <p>
              <label>
                Phone{required.has('phone') ? '' : mode === 'either' ? ' (optional if you give an email)' : ''}
                <input type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} required={required.has('phone')} autoComplete="tel" />
              </label>
            </p>
          )}
          <button type="submit" disabled={busy}>Send code{showEmail && showPhone && mode !== 'either' ? 's' : ''}</button>
        </form>
      )}

      {tab === 'signup' && step === 'codes' && (
        <section>
          <p>Enter the 6-digit code we sent{pending.length > 1 ? ' to each' : ''}.</p>
          {pending.map((ch, i) => (
            <form key={ch} onSubmit={(e) => { e.preventDefault(); verify(ch) }}>
              <p>
                <label>
                  Code sent to {sentTo[ch]} ({ch})
                  <input
                    ref={i === 0 ? codeRef : undefined}
                    value={codes[ch] ?? ''}
                    onChange={(e) => setCodes((c) => ({ ...c, [ch]: e.target.value.replace(/\D/g, '').slice(0, 6) }))}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    pattern="[0-9]{6}"
                    required
                  />
                </label>{' '}
                <button type="submit" disabled={busy || (codes[ch] ?? '').length !== 6}>Confirm {ch}</button>{' '}
                <ResendButton resendAfter={resendAt[ch] ?? null} onResend={() => resend(ch)} />
              </p>
            </form>
          ))}
          <p>{pending.length} left to confirm.</p>
        </section>
      )}

      {tab === 'signin' && step === 'signin-contact' && config && (
        <form onSubmit={startLogin}>
          {config.channels.length > 1 && (
            <p>
              <label>
                Sign in with
                <select value={loginChannel} onChange={(e) => setLoginChannel(e.target.value as Channel)}>
                  {config.channels.map((c) => (
                    <option key={c} value={c}>{LABEL[c]}</option>
                  ))}
                </select>
              </label>
            </p>
          )}
          <p>
            <label>
              {LABEL[loginChannel]}
              <input
                type={loginChannel === 'email' ? 'email' : 'tel'}
                value={loginContact}
                onChange={(e) => setLoginContact(e.target.value)}
                required
                autoComplete={loginChannel === 'email' ? 'email' : 'tel'}
              />
            </label>
          </p>
          <button type="submit" disabled={busy}>Send code</button>
        </form>
      )}

      {tab === 'signin' && step === 'signin-code' && (
        <form onSubmit={finishLogin}>
          <p>
            <label>
              6-digit code
              <input
                ref={codeRef}
                value={loginCode}
                onChange={(e) => setLoginCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                required
              />
            </label>
          </p>
          <button type="submit" disabled={busy || loginCode.length !== 6}>Sign in</button>{' '}
          <ResendButton
            resendAfter={loginResendAt}
            onResend={() =>
              void run(async () => {
                const s = await api.startLogin(loginChannel, loginContact)
                setLoginToken(s.challengeToken)
                setLoginResendAt(Date.parse(s.resendAfter))
                setInfo('A new code was sent.')
              })
            }
          />
        </form>
      )}

      <p role="status" aria-live="polite">{info}</p>
      <p role="alert" aria-live="assertive">{error}</p>
    </main>
  )
}

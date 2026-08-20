import { beforeAll, describe, expect, it } from 'vitest'
import { err } from '@/shared/result'
import type { Notifier } from '@/ports/notifier'
import type { RateLimiter } from '@/ports/rate-limiter'
import { harness, migrate, uniqueEmail } from '../../fixtures/harness'

beforeAll(migrate)

const PASSWORD = 'correct horse battery staple'

/** Complete a signup and return the address, for tests that need an account. */
async function signedUpAccount(): Promise<string> {
  const h = harness()
  const email = uniqueEmail()
  await h.post('/api/v1/auth/request-otp', { email, purpose: 'signup' })
  const res = await h.post('/api/v1/auth/complete-signup', {
    email,
    code: h.codeFor(email),
    password: PASSWORD,
  })
  expect(res.status).toBe(201)
  return email
}

describe('request-otp', () => {
  it('delivers a code of the configured length', async () => {
    const h = harness()
    const email = uniqueEmail()

    const res = await h.post('/api/v1/auth/request-otp', { email, purpose: 'signup' })

    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ status: 'accepted' })
    expect(h.codeFor(email)).toMatch(/^\d{6}$/)
  })

  it('accepts an unknown address without revealing that it is unknown', async () => {
    // ENUMERATION RESISTANCE: an address with no account must be
    // indistinguishable from one that has an account.
    const h = harness()
    const res = await h.post('/api/v1/auth/request-otp', {
      email: uniqueEmail(),
      purpose: 'password_reset',
    })
    expect(res.status).toBe(202)
  })

  it('rejects a malformed address before doing any work', async () => {
    const h = harness()
    const res = await h.post('/api/v1/auth/request-otp', {
      email: 'not-an-email',
      purpose: 'signup',
    })
    expect(res.status).toBe(400)
  })

  it('rate limits repeated requests for the same address', async () => {
    // Configured limit in tests is 3 per address.
    const h = harness()
    const email = uniqueEmail()

    for (let i = 0; i < 3; i++) {
      const ok = await h.post('/api/v1/auth/request-otp', { email, purpose: 'signup' })
      expect(ok.status).toBe(202)
    }

    const blocked = await h.post('/api/v1/auth/request-otp', { email, purpose: 'signup' })
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get('retry-after')).toBeTruthy()
    expect(await blocked.json()).toMatchObject({ error: 'rate_limited' })
  })

  it('returns 503 and delivers nothing when the notifier fails', async () => {
    // PORT SUBSTITUTION, failure path only: no HTTP request can force a
    // provider outage.
    const failing: Notifier = {
      send: async () => err({ kind: 'delivery_failed', reason: 'provider down' }),
    }
    const h = harness({ notifier: failing })

    const res = await h.post('/api/v1/auth/request-otp', {
      email: uniqueEmail(),
      purpose: 'signup',
    })

    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: 'service_unavailable' })
  })

  it('fails closed when the rate limiter is unavailable', async () => {
    // A broken limiter must NOT mean "allow everything" — that combination is
    // how an OTP endpoint becomes free email for an attacker.
    const broken: RateLimiter = {
      consume: async () => err({ kind: 'limiter_unavailable', reason: 'kv down' }),
    }
    const h = harness({ limiter: broken })

    const res = await h.post('/api/v1/auth/request-otp', {
      email: uniqueEmail(),
      purpose: 'signup',
    })

    expect(res.status).toBe(503)
  })
})

describe('complete-signup', () => {
  it('creates an account and returns a session', async () => {
    const h = harness()
    const email = uniqueEmail()
    await h.post('/api/v1/auth/request-otp', { email, purpose: 'signup' })

    const res = await h.post('/api/v1/auth/complete-signup', {
      email,
      code: h.codeFor(email),
      password: PASSWORD,
    })

    expect(res.status).toBe(201)
    expect(res.headers.get('set-cookie')).toBeTruthy()
    expect(await res.json()).toEqual({ userId: expect.any(String) })
  })

  it('rejects a wrong code', async () => {
    const h = harness()
    const email = uniqueEmail()
    await h.post('/api/v1/auth/request-otp', { email, purpose: 'signup' })

    const res = await h.post('/api/v1/auth/complete-signup', {
      email,
      code: '000000',
      password: PASSWORD,
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'invalid_code' })
  })

  it('reports an unknown address identically to a wrong code', async () => {
    // Both must be `invalid_code`. Distinguishing them would reveal which
    // addresses have a signup in progress.
    const h = harness()
    const res = await h.post('/api/v1/auth/complete-signup', {
      email: uniqueEmail(),
      code: '000000',
      password: PASSWORD,
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'invalid_code' })
  })

  it('locks the challenge after the configured number of wrong attempts', async () => {
    // Configured limit in tests is 5.
    const h = harness()
    const email = uniqueEmail()
    await h.post('/api/v1/auth/request-otp', { email, purpose: 'signup' })

    for (let i = 0; i < 4; i++) {
      const res = await h.post('/api/v1/auth/complete-signup', {
        email,
        code: '000000',
        password: PASSWORD,
      })
      expect(res.status).toBe(400)
    }

    const locked = await h.post('/api/v1/auth/complete-signup', {
      email,
      code: '000000',
      password: PASSWORD,
    })
    expect(locked.status).toBe(429)
    expect(await locked.json()).toMatchObject({ error: 'too_many_attempts' })

    // Lockout must survive a CORRECT code — otherwise brute force simply
    // continues until it lands.
    const correct = await h.post('/api/v1/auth/complete-signup', {
      email,
      code: h.codeFor(email),
      password: PASSWORD,
    })
    expect(correct.status).toBe(429)
  })

  it('refuses to reuse a consumed code', async () => {
    const h = harness()
    const email = uniqueEmail()
    await h.post('/api/v1/auth/request-otp', { email, purpose: 'signup' })
    const code = h.codeFor(email)

    const first = await h.post('/api/v1/auth/complete-signup', { email, code, password: PASSWORD })
    expect(first.status).toBe(201)

    const replay = await h.post('/api/v1/auth/complete-signup', { email, code, password: PASSWORD })
    expect(replay.status).toBe(400)
  })

  it('reports an expired code as expired, not as wrong', async () => {
    // CLOCK SUBSTITUTION, failure path only: reaching expiry through HTTP alone
    // would mean a test that genuinely waits ten minutes.
    const h = harness()
    const email = uniqueEmail()
    await h.post('/api/v1/auth/request-otp', { email, purpose: 'signup' })
    const code = h.codeFor(email)

    const later = new Date(Date.now() + 601_000)
    const future = harness({ clock: { now: () => later } })

    const res = await future.post('/api/v1/auth/complete-signup', {
      email,
      code,
      password: PASSWORD,
    })

    expect(res.status).toBe(410)
    expect(await res.json()).toMatchObject({ error: 'code_expired' })
  })

  it('rejects a short password BEFORE consuming the code', async () => {
    const h = harness()
    const email = uniqueEmail()
    await h.post('/api/v1/auth/request-otp', { email, purpose: 'signup' })
    const code = h.codeFor(email)

    const weak = await h.post('/api/v1/auth/complete-signup', { email, code, password: 'short' })
    expect(weak.status).toBe(422)
    expect(await weak.json()).toMatchObject({ error: 'weak_password' })

    // The code must still work — burning a single-use code on a password policy
    // failure would force the user to request another.
    const retry = await h.post('/api/v1/auth/complete-signup', { email, code, password: PASSWORD })
    expect(retry.status).toBe(201)
  })

  it('refuses a second account for the same address', async () => {
    const email = await signedUpAccount()

    const h = harness()
    await h.post('/api/v1/auth/request-otp', { email, purpose: 'signup' })
    const res = await h.post('/api/v1/auth/complete-signup', {
      email,
      code: h.codeFor(email),
      password: PASSWORD,
    })

    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'already_registered' })
  })

  it('treats addresses case-insensitively', async () => {
    const h = harness()
    const email = uniqueEmail()
    await h.post('/api/v1/auth/request-otp', { email: email.toUpperCase(), purpose: 'signup' })

    const res = await h.post('/api/v1/auth/complete-signup', {
      email,
      code: h.codeFor(email),
      password: PASSWORD,
    })

    expect(res.status).toBe(201)
  })
})

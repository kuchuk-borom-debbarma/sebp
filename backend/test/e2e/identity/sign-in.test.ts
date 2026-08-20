import { beforeAll, describe, expect, it } from 'vitest'
import { harness, migrate, uniqueEmail } from '../../fixtures/harness'

beforeAll(migrate)

const PASSWORD = 'correct horse battery staple'

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

describe('sign-in', () => {
  it('signs in with correct credentials', async () => {
    const email = await signedUpAccount()
    const h = harness()

    const res = await h.post('/api/v1/auth/sign-in', { email, password: PASSWORD })

    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toBeTruthy()
    expect(await res.json()).toEqual({ userId: expect.any(String) })
  })

  it('rejects a wrong password', async () => {
    const email = await signedUpAccount()
    const h = harness()

    const res = await h.post('/api/v1/auth/sign-in', { email, password: 'wrong password here' })

    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: 'invalid_credentials' })
  })

  it('reports an unknown account identically to a wrong password', async () => {
    // ENUMERATION RESISTANCE: both are `invalid_credentials`, 401. Any
    // difference would let anyone discover which founders have signed up.
    const h = harness()
    const res = await h.post('/api/v1/auth/sign-in', {
      email: uniqueEmail(),
      password: PASSWORD,
    })

    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: 'invalid_credentials' })
  })

  it('signs in regardless of address casing', async () => {
    const email = await signedUpAccount()
    const h = harness()

    const res = await h.post('/api/v1/auth/sign-in', {
      email: email.toUpperCase(),
      password: PASSWORD,
    })

    expect(res.status).toBe(200)
  })
})

describe('reset-password', () => {
  it('sets a new password and signs in with it', async () => {
    const email = await signedUpAccount()
    const h = harness()
    const NEW_PASSWORD = 'a completely different passphrase'

    await h.post('/api/v1/auth/request-otp', { email, purpose: 'password_reset' })
    const reset = await h.post('/api/v1/auth/reset-password', {
      email,
      code: h.codeFor(email),
      password: NEW_PASSWORD,
    })
    expect(reset.status).toBe(200)

    const withNew = await h.post('/api/v1/auth/sign-in', { email, password: NEW_PASSWORD })
    expect(withNew.status).toBe(200)

    const withOld = await h.post('/api/v1/auth/sign-in', { email, password: PASSWORD })
    expect(withOld.status).toBe(401)
  })

  it('will not accept a signup code for a reset', async () => {
    // Purpose scopes the lookup: a code issued for signup must not satisfy a
    // reset, or the weaker of the two flows becomes a way into any account.
    const email = await signedUpAccount()
    const h = harness()

    await h.post('/api/v1/auth/request-otp', { email, purpose: 'signup' })
    const signupCode = h.codeFor(email)

    const res = await h.post('/api/v1/auth/reset-password', {
      email,
      code: signupCode,
      password: 'another perfectly fine password',
    })

    expect(res.status).toBe(400)
  })

  it('rejects a short password before consuming the code', async () => {
    const email = await signedUpAccount()
    const h = harness()

    await h.post('/api/v1/auth/request-otp', { email, purpose: 'password_reset' })
    const code = h.codeFor(email)

    const weak = await h.post('/api/v1/auth/reset-password', { email, code, password: 'short' })
    expect(weak.status).toBe(422)

    const retry = await h.post('/api/v1/auth/reset-password', {
      email,
      code,
      password: 'a sufficiently long replacement',
    })
    expect(retry.status).toBe(200)
  })

  it('reports no account once the caller has proven the address', async () => {
    // request-otp deliberately does NOT check existence, so this is where an
    // address with no account surfaces. Safe to report: the caller has already
    // proven they control it.
    const h = harness()
    const email = uniqueEmail()

    await h.post('/api/v1/auth/request-otp', { email, purpose: 'password_reset' })
    const res = await h.post('/api/v1/auth/reset-password', {
      email,
      code: h.codeFor(email),
      password: 'a perfectly reasonable password',
    })

    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: 'account_not_found' })
  })
})

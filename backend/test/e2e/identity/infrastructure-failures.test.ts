import { beforeAll, describe, expect, it } from 'vitest'
import { err, ok } from '@/shared/result'
import type { Notifier } from '@/ports/notifier'
import type { RateLimiter } from '@/ports/rate-limiter'
import { harness, migrate, uniqueEmail } from '../../fixtures/harness'

beforeAll(migrate)

/**
 * Infrastructure failures, seen from the outside.
 *
 * This file asserts what a CALLER experiences when something behind the API
 * breaks. The precise catch-branch coverage lives in failure-paths.test.ts.
 *
 * HISTORY WORTH KNOWING: this file used to work by deliberately skipping
 * migrations so every query failed against absent tables. That produced genuine
 * D1 errors, but better-auth also issues internal queries on floating promises,
 * so five unhandled rejections surfaced AFTER the tests finished — enough to
 * fail the run despite every assertion passing. Injecting a failing database is
 * both more precise and free of that noise.
 */

const PASSWORD = 'correct horse battery staple'

/** A database whose every operation rejects. */
const brokenDb = {
  select: () => ({
    from: () => ({
      where: () => ({
        orderBy: () => ({
          limit: async () => {
            throw new Error('database unavailable')
          },
        }),
      }),
    }),
  }),
  insert: () => ({
    values: async () => {
      throw new Error('database unavailable')
    },
  }),
} as never

describe('when the database is unavailable', () => {
  it('returns 503 rather than a confusing 4xx on request-otp', async () => {
    const h = harness({ db: brokenDb })
    const res = await h.post('/api/v1/auth/request-otp', {
      email: uniqueEmail(),
      purpose: 'signup',
    })

    expect(res.status).toBe(503)

    // The underlying reason must NOT reach the client — it can carry database
    // detail. It goes to logs; the caller gets a generic message.
    const body = (await res.json()) as { error: string; message: string }
    expect(body.error).toBe('service_unavailable')
    expect(body.message).not.toMatch(/no such table|D1_ERROR|SQLITE|unavailable/i)
  })

  it('returns 503 on complete-signup', async () => {
    const h = harness({ db: brokenDb })
    const res = await h.post('/api/v1/auth/complete-signup', {
      email: uniqueEmail(),
      code: '123456',
      password: PASSWORD,
    })
    expect(res.status).toBe(503)
  })

  it('returns 503 on reset-password', async () => {
    const h = harness({ db: brokenDb })
    const res = await h.post('/api/v1/auth/reset-password', {
      email: uniqueEmail(),
      code: '123456',
      password: PASSWORD,
    })
    expect(res.status).toBe(503)
  })
})

describe('when the auth backend is failing', () => {
  it('does NOT report an outage as invalid credentials', async () => {
    /**
     * THIS TEST EXISTS BECAUSE IT CAUGHT A REAL BUG.
     *
     * better-auth returns a non-OK response for both a wrong password and an
     * internal error, and the adapter originally collapsed all of them into
     * `invalid_credentials`. A user with a perfectly good password would have
     * been told it was wrong during an outage — sent to reset a password that
     * was never the problem, while a genuine outage hid behind a plausible 401.
     *
     * 4xx still collapses (enumeration resistance); 5xx must not.
     */
    const failingAuth = {
      handler: async () => new Response('internal error', { status: 500 }),
    }
    const h = harness({ auth: failingAuth as never })

    const res = await h.post('/api/v1/auth/sign-in', {
      email: uniqueEmail(),
      password: PASSWORD,
    })

    expect(res.status).toBe(503)
    expect(res.status).not.toBe(401)
  })

  it('still reports a genuine credential failure as 401', async () => {
    const rejectingAuth = {
      handler: async () => new Response('unauthorized', { status: 401 }),
    }
    const h = harness({ auth: rejectingAuth as never })

    const res = await h.post('/api/v1/auth/sign-in', {
      email: uniqueEmail(),
      password: PASSWORD,
    })

    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: 'invalid_credentials' })
  })
})

describe('when a provider is unavailable', () => {
  it('surfaces an unsupported channel as 503, not a crash', async () => {
    const unsupported: Notifier = {
      send: async () => err({ kind: 'channel_unsupported', channel: 'sms' }),
    }
    const h = harness({ notifier: unsupported })

    const res = await h.post('/api/v1/auth/request-otp', {
      email: uniqueEmail(),
      purpose: 'signup',
    })

    expect(res.status).toBe(503)
  })

  it('reports the reset window when the per-address limit is hit', async () => {
    const atLimit: RateLimiter = {
      consume: async () =>
        ok({ allowed: false, remaining: 0, resetAt: new Date(Date.now() + 42_000) }),
    }
    const h = harness({ limiter: atLimit })

    const res = await h.post('/api/v1/auth/request-otp', {
      email: uniqueEmail(),
      purpose: 'signup',
    })

    expect(res.status).toBe(429)
    // Retry-After must be present and sensible, or clients hammer the endpoint.
    const retryAfter = Number(res.headers.get('retry-after'))
    expect(retryAfter).toBeGreaterThan(0)
    expect(retryAfter).toBeLessThanOrEqual(43)
  })
})

import { beforeAll, describe, expect, it } from 'vitest'
import { err, ok } from '@/shared/result'
import { loadConfig } from '@/config'
import { buildContainer } from '@/container'
import { createApp } from '@/http/app'
import { createDatabase } from '@/platform/d1/client'
import type { OtpChallengeRepo } from '@/modules/identity'
import { harness, migrate, testEnv, uniqueEmail } from '../../fixtures/harness'

beforeAll(migrate)

const PASSWORD = 'correct horse battery staple'
const REPO_ERROR = err({ kind: 'repo_failed' as const, reason: 'simulated' })

/**
 * Branches that no HTTP request can force.
 *
 * Every substitution here is on a FAILURE path — a repository that errors, a
 * WebCrypto that throws, a KV binding that is unavailable. That is the one
 * sanctioned use under CONVE-16. None of these makes a happy path easier; each
 * one reaches an error branch that is otherwise unreachable from outside the
 * process, and would therefore be permanently uncoverable.
 */

/** A valid, unconsumed challenge for `destination`. */
const challengeFor = (destination: string) => ({
  id: 'test-challenge-id' as never,
  purpose: 'signup' as const,
  channel: 'email' as const,
  destination,
  codeHash: 'deadbeef',
  attempts: 0,
  maxAttempts: 5,
  expiresAt: new Date(Date.now() + 60_000),
  consumedAt: null,
  createdAt: new Date(),
})

/** A repo where every method fails, with selective overrides per test. */
const failingRepo = (over: Partial<OtpChallengeRepo> = {}): OtpChallengeRepo => ({
  findActive: async () => REPO_ERROR,
  save: async () => REPO_ERROR,
  incrementAttempts: async () => REPO_ERROR,
  consume: async () => REPO_ERROR,
  deleteFor: async () => REPO_ERROR,
  ...over,
})

/** WebCrypto that always throws, to reach the hasher's own catch blocks. */
const brokenSubtle = {
  importKey: async () => {
    throw new Error('subtle unavailable')
  },
  sign: async () => {
    throw new Error('subtle unavailable')
  },
} as unknown as SubtleCrypto

describe('repository failures surface as 503, never as a wrong answer', () => {
  it('when looking up a challenge fails', async () => {
    const h = harness({ otpRepo: failingRepo() })
    const res = await h.post('/api/v1/auth/complete-signup', {
      email: uniqueEmail(),
      code: '123456',
      password: PASSWORD,
    })
    expect(res.status).toBe(503)
  })

  it('when saving a new challenge fails', async () => {
    const h = harness({ otpRepo: failingRepo() })
    const res = await h.post('/api/v1/auth/request-otp', {
      email: uniqueEmail(),
      purpose: 'signup',
    })
    expect(res.status).toBe(503)
  })

  it('when recording a failed attempt fails', async () => {
    // A wrong code that cannot be counted must not silently succeed — otherwise
    // attempt limiting quietly stops working.
    const real = harness()
    const email = uniqueEmail()
    await real.post('/api/v1/auth/request-otp', { email, purpose: 'signup' })

    const h = harness({
      otpRepo: failingRepo({
        findActive: async () => ok(challengeFor(email)),
      }),
    })

    const res = await h.post('/api/v1/auth/complete-signup', {
      email,
      code: '000000',
      password: PASSWORD,
    })
    expect(res.status).toBe(503)
  })

  it('when consuming a verified challenge fails', async () => {
    // The code is correct and the challenge is valid — only the write that
    // marks it consumed fails. The caller must NOT be told the code was wrong.
    const h = harness({
      otpRepo: failingRepo({
        findActive: async () => ok(challengeFor('consume-fail@example.com')),
        consume: async () => REPO_ERROR,
      }),
      hasher: { hash: async () => ok('deadbeef'), verify: async () => ok(true) },
    })

    const res = await h.post('/api/v1/auth/complete-signup', {
      email: 'consume-fail@example.com',
      code: '123456',
      password: PASSWORD,
    })

    expect(res.status).toBe(503)
  })

  it('reports a lost consume race as an invalid code, not a success', async () => {
    // Two requests submitting the same valid code concurrently: the loser must
    // be rejected, not handed a second account.
    const h = harness({
      otpRepo: failingRepo({
        findActive: async () => ok(challengeFor('race@example.com')),
        // The code "matches" is decided by the hasher; force consume to lose.
        consume: async () => ok(false),
      }),
      hasher: {
        hash: async () => ok('deadbeef'),
        verify: async () => ok(true),
      },
    })

    const res = await h.post('/api/v1/auth/complete-signup', {
      email: 'race@example.com',
      code: '123456',
      password: PASSWORD,
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'invalid_code' })
  })
})

describe('hashing failures', () => {
  it('returns 503 when hashing a new code fails', async () => {
    const h = harness({ subtle: brokenSubtle })
    const res = await h.post('/api/v1/auth/request-otp', {
      email: uniqueEmail(),
      purpose: 'signup',
    })
    expect(res.status).toBe(503)
  })

  it('returns 503 when verifying a code fails', async () => {
    const real = harness()
    const email = uniqueEmail()
    await real.post('/api/v1/auth/request-otp', { email, purpose: 'signup' })
    const code = real.codeFor(email)

    const h = harness({ subtle: brokenSubtle })
    const res = await h.post('/api/v1/auth/complete-signup', { email, code, password: PASSWORD })
    expect(res.status).toBe(503)
  })
})

describe('rate limiter storage failure', () => {
  it('fails closed when the KV binding throws', async () => {
    const brokenKv = {
      get: async () => {
        throw new Error('kv unavailable')
      },
      put: async () => {
        throw new Error('kv unavailable')
      },
    } as unknown as KVNamespace

    const h = harness({ kv: brokenKv })
    const res = await h.post('/api/v1/auth/request-otp', {
      email: uniqueEmail(),
      purpose: 'signup',
    })

    // Fail CLOSED: a broken limiter plus an open OTP endpoint is how a
    // five-figure email bill happens.
    expect(res.status).toBe(503)
  })

  it('treats a corrupted counter as exhausted rather than absent', async () => {
    const corrupted = {
      get: async () => 'not-a-number',
      put: async () => undefined,
    } as unknown as KVNamespace

    const h = harness({ kv: corrupted })
    const res = await h.post('/api/v1/auth/request-otp', {
      email: uniqueEmail(),
      purpose: 'signup',
    })

    expect(res.status).toBe(429)
  })
})

describe('container and app configuration branches', () => {
  it('refuses to build with a notifier driver that is not implemented', () => {
    // Reaching here means NOTIFIER_DRIVER=pingram was set before the adapter
    // exists. Failing loudly beats silently dropping every message.
    expect(() =>
      buildContainer(
        { ...testEnv, ENVIRONMENT: 'development', NOTIFIER_DRIVER: 'pingram' } as never,
        'https://api.test.local',
      ),
    ).toThrow(/not implemented yet/)
  })

  it('omits Swagger UI when it is disabled', async () => {
    const config = loadConfig({ ...testEnv, SWAGGER_ENABLED: 'false' })
    expect(config.http.swaggerEnabled).toBe(false)

    const container = buildContainer({ ...testEnv, SWAGGER_ENABLED: 'false' } as never, 'https://api.test.local')
    const app = createApp(container)

    const res = await app.request('https://api.test.local/docs', {}, testEnv)
    expect(res.status).toBe(404)
  })
})

describe('console notifier', () => {
  it('reports no message for an address it never sent to', async () => {
    const h = harness()
    expect(h.container.consoleNotifier?.lastTo('never-used@example.com')).toBeUndefined()
  })
})

describe('branches that guard against changes elsewhere', () => {
  it('rejects a challenge that is already consumed', async () => {
    // findActive filters consumed rows, so this branch is defence in depth
    // against that filter changing. Reachable only via an injected repo.
    const h = harness({
      otpRepo: failingRepo({
        findActive: async () => ok({ ...challengeFor('used@example.com'), consumedAt: new Date() }),
      }),
      hasher: { hash: async () => ok('deadbeef'), verify: async () => ok(true) },
    })

    const res = await h.post('/api/v1/auth/complete-signup', {
      email: 'used@example.com',
      code: '123456',
      password: PASSWORD,
    })

    expect(res.status).toBe(400)
  })

  it('locks out on the final wrong attempt, not one attempt later', async () => {
    // attempts === maxAttempts - 1 and a wrong code: attemptsRemaining hits 0,
    // so this must report exhaustion rather than "one attempt left".
    const h = harness({
      otpRepo: failingRepo({
        findActive: async () => ok({ ...challengeFor('last@example.com'), attempts: 4, maxAttempts: 5 }),
        incrementAttempts: async () => ok(undefined),
      }),
      hasher: { hash: async () => ok('deadbeef'), verify: async () => ok(false) },
    })

    const res = await h.post('/api/v1/auth/complete-signup', {
      email: 'last@example.com',
      code: '000000',
      password: PASSWORD,
    })

    expect(res.status).toBe(429)
    expect(await res.json()).toMatchObject({ error: 'too_many_attempts' })
  })

  it('fails closed when the per-address limiter fails after the per-IP one passed', async () => {
    // The two limiter calls are checked in order, so the second one's failure
    // branch needs the first to succeed.
    let call = 0
    const h = harness({
      limiter: {
        consume: async () => {
          call += 1
          return call === 1
            ? ok({ allowed: true, remaining: 9, resetAt: new Date(Date.now() + 60_000) })
            : err({ kind: 'limiter_unavailable', reason: 'kv down on second call' })
        },
      },
    })

    const res = await h.post('/api/v1/auth/request-otp', {
      email: uniqueEmail(),
      purpose: 'signup',
    })

    expect(res.status).toBe(503)
  })

  it('surfaces a malformed auth response rather than crashing', async () => {
    // Guards against better-auth changing its response shape between versions.
    const noCookie = {
      handler: async () => new Response(JSON.stringify({ user: { id: 'u1' } }), { status: 200 }),
    }
    const h = harness({
      otpRepo: failingRepo({
        findActive: async () => ok(challengeFor('malformed@example.com')),
        consume: async () => ok(true),
        deleteFor: async () => ok(undefined),
      }),
      hasher: { hash: async () => ok('deadbeef'), verify: async () => ok(true) },
      auth: noCookie as never,
    })

    const res = await h.post('/api/v1/auth/complete-signup', {
      email: 'malformed@example.com',
      code: '123456',
      password: PASSWORD,
    })

    expect(res.status).toBe(503)
  })

  it('surfaces an auth response with no user id', async () => {
    const noUserId = {
      handler: async () =>
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'set-cookie': 'session=abc' },
        }),
    }
    const h = harness({
      otpRepo: failingRepo({
        findActive: async () => ok(challengeFor('nouser@example.com')),
        consume: async () => ok(true),
        deleteFor: async () => ok(undefined),
      }),
      hasher: { hash: async () => ok('deadbeef'), verify: async () => ok(true) },
      auth: noUserId as never,
    })

    const res = await h.post('/api/v1/auth/complete-signup', {
      email: 'nouser@example.com',
      code: '123456',
      password: PASSWORD,
    })

    expect(res.status).toBe(503)
  })

  it('passes better-auth its own endpoints', async () => {
    // /api/auth/* is mounted so better-auth can serve session refresh and
    // sign-out. It must be reachable.
    const res = await harness().get('/api/auth/session')
    expect(res.status).toBeLessThan(500)
  })
})

describe('remaining defensive branches', () => {
  it('handles a non-Error thrown by WebCrypto', async () => {
    // `cause instanceof Error ? cause.message : String(cause)` — the String side.
    const throwsString = {
      importKey: async () => {
        throw 'not an Error object'
      },
      sign: async () => {
        throw 'not an Error object'
      },
    } as unknown as SubtleCrypto

    const h = harness({ subtle: throwsString })
    const res = await h.post('/api/v1/auth/request-otp', {
      email: uniqueEmail(),
      purpose: 'signup',
    })
    expect(res.status).toBe(503)
  })

  it('handles a non-Error thrown by KV', async () => {
    const throwsString = {
      get: async () => {
        throw 'kv exploded'
      },
      put: async () => undefined,
    } as unknown as KVNamespace

    const h = harness({ kv: throwsString })
    const res = await h.post('/api/v1/auth/request-otp', {
      email: uniqueEmail(),
      purpose: 'signup',
    })
    expect(res.status).toBe(503)
  })

  it('buckets callers with no CF-Connecting-IP header together', async () => {
    // The `?? 'unknown'` fallback. All unknown callers share one bucket, which
    // is restrictive rather than permissive — the right direction to fail in.
    const h = harness()
    const res = await h.app.request(
      'https://api.test.local/api/v1/auth/request-otp',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: uniqueEmail(), purpose: 'signup' }),
      },
      testEnv,
    )
    expect([202, 429]).toContain(res.status)
  })

  it('clamps Retry-After to at least one second', async () => {
    // A window that has already reset would otherwise yield 0 or negative.
    const expired = {
      consume: async () => ok({ allowed: false, remaining: 0, resetAt: new Date(Date.now() - 5_000) }),
    }
    const h = harness({ limiter: expired })

    const res = await h.post('/api/v1/auth/request-otp', {
      email: uniqueEmail(),
      purpose: 'signup',
    })

    expect(res.status).toBe(429)
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)
  })

  it('reports a root-level config error with no field path', async () => {
    // `i.path.join('.') || '(root)'` — the '(root)' side, when the whole value
    // is the wrong shape rather than one field.
    expect(() => loadConfig('not an object')).toThrow(/\(root\)/)
  })

  it('builds a container whose notifier is overridden and driver is not console', () => {
    // console_ is undefined AND a notifier was supplied — the branch where the
    // container omits consoleNotifier from its result.
    const container = buildContainer(
      { ...testEnv, NOTIFIER_DRIVER: 'pingram' } as never,
      'https://api.test.local',
      { notifier: { send: async () => ok({ id: 'x', sentAt: new Date() }) } },
    )
    expect(container.consoleNotifier).toBeUndefined()
  })

  it('enables cross-subdomain cookies when a cookie domain is configured', () => {
    // The ternary in the better-auth instance config.
    const container = buildContainer(
      { ...testEnv, SESSION_COOKIE_DOMAIN: '.sebp.test' } as never,
      'https://api.test.local',
    )
    expect(container.config.session.cookieDomain).toBe('.sebp.test')
  })
})

describe('auth adapter error handling', () => {
  const authReturning = (status: number, body: string) => ({
    handler: async () => new Response(body, { status }),
  })
  const authThrowing = {
    handler: async () => {
      throw new Error('auth exploded')
    },
    get $context() {
      return Promise.reject(new Error('auth exploded'))
    },
  }

  const verifiedRepo = (email: string) =>
    failingRepo({
      findActive: async () => ok(challengeFor(email)),
      consume: async () => ok(true),
      deleteFor: async () => ok(undefined),
    })
  const alwaysMatches = { hash: async () => ok('deadbeef'), verify: async () => ok(true) }

  it('distinguishes a generic signup failure from a duplicate', async () => {
    // A 4xx whose body does NOT mention existence must not be reported as 409.
    const h = harness({
      otpRepo: verifiedRepo('generic@example.com'),
      hasher: alwaysMatches,
      auth: authReturning(400, 'some other validation problem') as never,
    })

    const res = await h.post('/api/v1/auth/complete-signup', {
      email: 'generic@example.com',
      code: '123456',
      password: PASSWORD,
    })
    expect(res.status).toBe(503)
  })

  it('catches a throwing auth backend on signup', async () => {
    const h = harness({
      otpRepo: verifiedRepo('throws@example.com'),
      hasher: alwaysMatches,
      auth: authThrowing as never,
    })

    const res = await h.post('/api/v1/auth/complete-signup', {
      email: 'throws@example.com',
      code: '123456',
      password: PASSWORD,
    })
    expect(res.status).toBe(503)
  })

  it('catches a throwing auth backend on sign-in', async () => {
    const h = harness({ auth: authThrowing as never })
    const res = await h.post('/api/v1/auth/sign-in', {
      email: uniqueEmail(),
      password: PASSWORD,
    })
    expect(res.status).toBe(503)
  })

  it('catches a throwing auth backend on password reset', async () => {
    const h = harness({
      otpRepo: verifiedRepo('reset-throws@example.com'),
      hasher: alwaysMatches,
      auth: authThrowing as never,
    })

    const res = await h.post('/api/v1/auth/reset-password', {
      email: 'reset-throws@example.com',
      code: '123456',
      password: PASSWORD,
    })
    expect(res.status).toBe(503)
  })
})

describe('console notifier retention', () => {
  it('bounds its buffer so a long dev session cannot grow it without limit', async () => {
    /**
     * Reaching the trim needs more than MAX_RETAINED messages through ONE
     * container, and the per-IP rate limit caps a single container far below
     * that. The limiter is substituted to remove that unrelated obstacle — it is
     * not making an assertion easier, it is the only way to reach a defensive
     * branch that exists precisely for long-running sessions.
     */
    const permissive = {
      consume: async () => ok({ allowed: true, remaining: 99, resetAt: new Date(Date.now() + 60_000) }),
    }
    const h = harness({ limiter: permissive })

    for (let i = 0; i < 105; i++) {
      await h.post('/api/v1/auth/request-otp', {
        email: `bulk-${i}@example.com`,
        purpose: 'signup',
      })
    }

    const retained = h.container.consoleNotifier?.sent.length ?? 0
    expect(retained).toBeLessThanOrEqual(100)
    // The most recent message must still be findable after trimming.
    expect(h.container.consoleNotifier?.lastTo('bulk-104@example.com')).toBeDefined()
  })
})

describe('final branches', () => {
  it('handles a non-Error thrown by the auth backend', async () => {
    const throwsString = {
      handler: async () => {
        throw 'auth threw a string'
      },
    }
    const h = harness({ auth: throwsString as never })

    const res = await h.post('/api/v1/auth/sign-in', {
      email: uniqueEmail(),
      password: PASSWORD,
    })
    expect(res.status).toBe(503)
  })

  it('scans past non-matching messages when looking one up', async () => {
    // The earlier "no message" test ran against an EMPTY buffer, so the
    // comparison inside the loop was never evaluated at all. This one has
    // messages present and asks for a different address.
    const h = harness()
    const email = uniqueEmail()
    await h.post('/api/v1/auth/request-otp', { email, purpose: 'signup' })

    expect(h.container.consoleNotifier?.lastTo(email)).toBeDefined()
    expect(h.container.consoleNotifier?.lastTo('someone-else@example.com')).toBeUndefined()
  })

  it('reports a delivery failure and an unsupported channel differently', async () => {
    // Both sides of the notifier-error ternary, for a password_reset so the
    // reset-specific subject and body are exercised too.
    const failed = harness({
      notifier: { send: async () => err({ kind: 'delivery_failed', reason: 'smtp refused' }) },
    })
    const a = await failed.post('/api/v1/auth/request-otp', {
      email: uniqueEmail(),
      purpose: 'password_reset',
    })
    expect(a.status).toBe(503)

    const unsupported = harness({
      notifier: { send: async () => err({ kind: 'channel_unsupported', channel: 'sms' }) },
    })
    const b = await unsupported.post('/api/v1/auth/request-otp', {
      email: uniqueEmail(),
      purpose: 'password_reset',
    })
    expect(b.status).toBe(503)
  })
})

describe('repository catch branches', () => {
  /**
   * A Drizzle client whose write paths throw. Reaches the repository's own catch
   * blocks with the REAL adapter running — injecting the DB rather than
   * replacing the repo, the same seam pattern used for WebCrypto and KV.
   *
   * `select` succeeds and returns a stored challenge so the flow gets far enough
   * to attempt a write; `update` and `delete` then blow up.
   */
  const throwingDb = (stored: unknown[]) =>
    ({
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({ limit: async () => stored }),
          }),
        }),
      }),
      insert: () => ({
        values: async () => {
          throw new Error('insert failed')
        },
      }),
      update: () => ({
        set: () => ({
          where: async () => {
            throw new Error('update failed')
          },
        }),
      }),
      delete: () => ({
        where: async () => {
          throw new Error('delete failed')
        },
      }),
    }) as never

  const row = (over: Record<string, unknown> = {}) => ({
    id: 'row-id',
    purpose: 'signup',
    channel: 'email',
    destination: 'dbfail@example.com',
    codeHash: 'deadbeef',
    attempts: 0,
    maxAttempts: 5,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    consumedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  })

  it('returns 503 when inserting a challenge throws', async () => {
    const h = harness({ db: throwingDb([]) })
    const res = await h.post('/api/v1/auth/request-otp', {
      email: uniqueEmail(),
      purpose: 'signup',
    })
    expect(res.status).toBe(503)
  })

  it('returns 503 when incrementing the attempt counter throws', async () => {
    // A wrong code that cannot be counted must not pass silently.
    const h = harness({ db: throwingDb([row()]) })
    const res = await h.post('/api/v1/auth/complete-signup', {
      email: 'dbfail@example.com',
      code: '000000',
      password: PASSWORD,
    })
    expect(res.status).toBe(503)
  })

  it('returns 503 when consuming a verified challenge throws', async () => {
    const h = harness({
      db: throwingDb([row()]),
      hasher: { hash: async () => ok('deadbeef'), verify: async () => ok(true) },
    })
    const res = await h.post('/api/v1/auth/complete-signup', {
      email: 'dbfail@example.com',
      code: '123456',
      password: PASSWORD,
    })
    expect(res.status).toBe(503)
  })

  it('surfaces a lookup failure when the stored row is unreadable', async () => {
    const brokenSelect = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: async () => {
                throw new Error('select failed')
              },
            }),
          }),
        }),
      }),
    } as never

    const h = harness({ db: brokenSelect })
    const res = await h.post('/api/v1/auth/complete-signup', {
      email: uniqueEmail(),
      code: '123456',
      password: PASSWORD,
    })
    expect(res.status).toBe(503)
  })
})

describe('repository edge branches', () => {
  it('ignores a cleanup failure after a successful signup', async () => {
    /**
     * `deleteFor` clears leftover challenges after signup. Its failure is
     * deliberately NOT surfaced: the account exists and the user is signed in,
     * so failing the request would tell them signup failed when it did not —
     * and they could not retry, because the account already exists.
     *
     * Built from the REAL database with only `delete` replaced, so everything
     * up to the cleanup runs for real.
     */
    const real = createDatabase(testEnv.DB)
    // A Proxy, not a spread: Drizzle's methods live on the prototype, so
    // `{ ...real }` silently drops insert/select and the flow never gets far
    // enough to reach the cleanup.
    const deleteThrows = new Proxy(real, {
      get: (target, prop, receiver) =>
        prop === 'delete'
          ? () => ({
              where: async () => {
                throw new Error('cleanup failed')
              },
            })
          : Reflect.get(target, prop, receiver),
    }) as never

    const h = harness({ db: deleteThrows })
    const email = uniqueEmail()

    await h.post('/api/v1/auth/request-otp', { email, purpose: 'signup' })
    const res = await h.post('/api/v1/auth/complete-signup', {
      email,
      code: h.codeFor(email),
      password: PASSWORD,
    })

    // Signup still succeeds despite the cleanup failing.
    expect(res.status).toBe(201)
  })

  it('maps a consumed timestamp back to a Date', async () => {
    // toDomain's `consumedAt === null ? null : new Date(...)` — the non-null side.
    const consumedRow = {
      id: 'consumed-row',
      purpose: 'signup',
      channel: 'email',
      destination: 'consumed-row@example.com',
      codeHash: 'deadbeef',
      attempts: 0,
      maxAttempts: 5,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      consumedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    const db = {
      select: () => ({
        from: () => ({
          where: () => ({ orderBy: () => ({ limit: async () => [consumedRow] }) }),
        }),
      }),
    } as never

    const h = harness({
      db,
      hasher: { hash: async () => ok('deadbeef'), verify: async () => ok(true) },
    })

    const res = await h.post('/api/v1/auth/complete-signup', {
      email: 'consumed-row@example.com',
      code: '123456',
      password: PASSWORD,
    })

    // A consumed challenge is rejected, not reused.
    expect(res.status).toBe(400)
  })

  it('treats a missing affected-row count as having consumed nothing', async () => {
    // `result.meta?.changes ?? 0` — a driver that returns no meta must be read
    // as "did not win the race", never as success.
    const noMeta = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: async () => [
                {
                  id: 'nometa',
                  purpose: 'signup',
                  channel: 'email',
                  destination: 'nometa@example.com',
                  codeHash: 'deadbeef',
                  attempts: 0,
                  maxAttempts: 5,
                  expiresAt: new Date(Date.now() + 60_000).toISOString(),
                  consumedAt: null,
                  createdAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                },
              ],
            }),
          }),
        }),
      }),
      update: () => ({ set: () => ({ where: async () => ({}) }) }),
    } as never

    const h = harness({
      db: noMeta,
      hasher: { hash: async () => ok('deadbeef'), verify: async () => ok(true) },
    })

    const res = await h.post('/api/v1/auth/complete-signup', {
      email: 'nometa@example.com',
      code: '123456',
      password: PASSWORD,
    })

    expect(res.status).toBe(400)
  })
})

describe('repository error normalisation', () => {
  it('handles a non-Error thrown by the database driver', async () => {
    // `cause instanceof Error ? cause.message : String(cause)` — the String side.
    const throwsString = {
      insert: () => ({
        values: async () => {
          throw 'driver threw a string'
        },
      }),
    } as never

    const h = harness({ db: throwsString })
    const res = await h.post('/api/v1/auth/request-otp', {
      email: uniqueEmail(),
      purpose: 'signup',
    })
    expect(res.status).toBe(503)
  })
})

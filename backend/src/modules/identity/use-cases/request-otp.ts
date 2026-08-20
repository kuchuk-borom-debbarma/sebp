import type { Clock } from '@/ports/clock'
import type { CodeHasher } from '@/ports/code-hasher'
import type { IdGenerator } from '@/ports/id-generator'
import type { Notifier } from '@/ports/notifier'
import type { RateLimiter } from '@/ports/rate-limiter'
import type { Random } from '@/ports/random'
import { asOtpChallengeId } from '@/shared/ids'
import { err, ok, type Result } from '@/shared/result'
import type { IdentityError } from '../domain/errors'
import {
  expiryFrom,
  normaliseDestination,
  type OtpChallenge,
  type OtpPurpose,
} from '../domain/otp-challenge'
import type { OtpChallengeRepo } from '../ports/otp-challenge-repo'

/**
 * Issue a one-time code and deliver it.
 *
 * RULE ENFORCED: a caller may request codes only within the configured rate
 * limits, per address AND per IP.
 *
 * ERRORS RETURNED: `rate_limited`, `infrastructure`.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ──────────────────────────────────────
 * It does not check whether an account already exists, and it does not report
 * that either way. Doing so would turn this endpoint into an account-enumeration
 * oracle: anyone could discover which founders have applied by watching which
 * addresses respond differently. The route returns 202 unconditionally.
 *
 * The duplicate-account check happens at complete-signup instead, where the
 * caller has already proven control of the address.
 */

export type RequestOtpDeps = {
  readonly repo: OtpChallengeRepo
  readonly notifier: Notifier
  readonly limiter: RateLimiter
  readonly hasher: CodeHasher
  readonly random: Random
  readonly ids: IdGenerator
  readonly clock: Clock
  readonly config: {
    readonly codeLength: number
    readonly expirySeconds: number
    readonly maxAttempts: number
    readonly perEmail: number
    readonly perIp: number
    readonly windowSeconds: number
  }
}

export type RequestOtpInput = {
  readonly destination: string
  readonly purpose: OtpPurpose
  /** Caller IP, for the second rate-limit dimension. */
  readonly ip: string
}

export function requestOtp(deps: RequestOtpDeps) {
  return async (input: RequestOtpInput): Promise<Result<void, IdentityError>> => {
    const { repo, notifier, limiter, hasher, random, ids, clock, config } = deps
    const destination = normaliseDestination(input.destination)
    const now = clock.now()

    /**
     * BOTH dimensions are checked, and per-IP first.
     *
     * Per-address alone stops one victim being spammed but not an attacker
     * cycling through thousands of addresses — which is the case that actually
     * burns the sending reputation. Per-IP alone stops the reverse. Neither
     * alone is sufficient.
     */
    const ipCheck = await limiter.consume(
      `otp:ip:${input.ip}`,
      config.perIp,
      config.windowSeconds,
    )
    if (!ipCheck.ok) {
      // FAIL CLOSED. A broken limiter plus an open OTP endpoint is how a
      // five-figure email bill happens.
      return err({ kind: 'infrastructure', source: 'rate_limiter', reason: ipCheck.error.reason })
    }
    if (!ipCheck.value.allowed) {
      return err({
        kind: 'rate_limited',
        retryAfterSeconds: retryAfter(ipCheck.value.resetAt, now),
      })
    }

    const emailCheck = await limiter.consume(
      `otp:dest:${destination}`,
      config.perEmail,
      config.windowSeconds,
    )
    if (!emailCheck.ok) {
      return err({ kind: 'infrastructure', source: 'rate_limiter', reason: emailCheck.error.reason })
    }
    if (!emailCheck.value.allowed) {
      return err({
        kind: 'rate_limited',
        retryAfterSeconds: retryAfter(emailCheck.value.resetAt, now),
      })
    }

    const code = random.digits(config.codeLength)

    const hashed = await hasher.hash(code)
    if (!hashed.ok) {
      return err({ kind: 'infrastructure', source: 'hasher', reason: hashed.error.reason })
    }

    const challenge: OtpChallenge = {
      id: asOtpChallengeId(ids.next()),
      purpose: input.purpose,
      // Email only today. When phone lands, this comes from the input and
      // nothing else in this function changes.
      channel: 'email',
      destination,
      codeHash: hashed.value,
      attempts: 0,
      // Snapshotted, NOT read live at verify time: changing the configured limit
      // must not retroactively lock out a challenge already in flight.
      maxAttempts: config.maxAttempts,
      expiresAt: expiryFrom(now, config.expirySeconds),
      consumedAt: null,
      createdAt: now,
    }

    const saved = await repo.save(challenge)
    if (!saved.ok) {
      return err({ kind: 'infrastructure', source: 'repo', reason: saved.error.reason })
    }

    /**
     * Delivery happens AFTER the challenge is persisted. The reverse order would
     * let a user receive a code that does not exist in the database if the write
     * then failed — unverifiable, and indistinguishable from a wrong code.
     */
    const delivered = await notifier.send({
      channel: challenge.channel,
      destination,
      subject: subjectFor(input.purpose),
      body: bodyFor(input.purpose, code, config.expirySeconds),
    })
    if (!delivered.ok) {
      return err({
        kind: 'infrastructure',
        source: 'notifier',
        reason: delivered.error.kind === 'delivery_failed'
          ? delivered.error.reason
          : `channel unsupported: ${delivered.error.channel}`,
      })
    }

    return ok(undefined)
  }
}

const retryAfter = (resetAt: Date, now: Date): number =>
  Math.max(1, Math.ceil((resetAt.getTime() - now.getTime()) / 1000))

const subjectFor = (purpose: OtpPurpose): string =>
  purpose === 'signup' ? 'Your sebp verification code' : 'Reset your sebp password'

/**
 * The code is interpolated into the body — and the body is what the console
 * adapter prints in development. It must never be written to the general logger.
 */
const bodyFor = (purpose: OtpPurpose, code: string, expirySeconds: number): string => {
  const minutes = Math.round(expirySeconds / 60)
  const action = purpose === 'signup' ? 'finish creating your account' : 'reset your password'
  return `Your code is ${code}. Use it to ${action}. It expires in ${minutes} minutes and can be used once.`
}

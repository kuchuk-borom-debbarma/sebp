import type { OtpChallengeId } from '@/shared/ids'
import { err, ok, type Result } from '@/shared/result'

/**
 * OTP challenge rules. Pure: no framework, no I/O, no clock, no crypto.
 *
 * Everything time-dependent takes `now` as an argument and everything
 * crypto-dependent takes the ALREADY-COMPUTED comparison result. That is what
 * keeps this file testable through HTTP at 100% coverage — each rule below is a
 * plain branch a request can drive, not a mocked interaction.
 */

/** Why a challenge was issued. Scopes lookups so one purpose cannot satisfy another. */
export type OtpPurpose = 'signup' | 'password_reset'

export type OtpChannel = 'email' | 'sms'

export type OtpChallenge = {
  readonly id: OtpChallengeId
  readonly purpose: OtpPurpose
  readonly channel: OtpChannel
  readonly destination: string
  readonly codeHash: string
  readonly attempts: number
  readonly maxAttempts: number
  readonly expiresAt: Date
  readonly consumedAt: Date | null
  readonly createdAt: Date
}

/**
 * Why a verification attempt failed.
 *
 * `not_found` and `code_mismatch` are separate internally so the attempt counter
 * can be incremented on one and not the other — but the HTTP layer MUST collapse
 * them into one response. Distinguishing "no challenge for this address" from
 * "wrong code" tells an attacker which addresses have pending signups.
 */
export type OtpFailure =
  | { kind: 'not_found' }
  | { kind: 'expired' }
  | { kind: 'already_consumed' }
  | { kind: 'attempts_exhausted' }
  | { kind: 'code_mismatch'; attemptsRemaining: number }

/**
 * Decide the outcome of a verification attempt.
 *
 * `codeMatches` is computed by the CodeHasher port (constant-time HMAC compare)
 * and passed in, so this function stays pure and every branch is reachable.
 *
 * ORDER IS DELIBERATE and should not be rearranged for tidiness:
 *
 *   1. consumed  — a reused code must never appear merely "expired"
 *   2. expired   — checked before attempts, so a stale challenge does not burn
 *                  an attempt and mislead a legitimate user into thinking they
 *                  mistyped
 *   3. exhausted — lockout survives even a correct code; otherwise brute force
 *                  simply continues until it succeeds
 *   4. mismatch  — only now does the actual code comparison matter
 *
 * Note that (3) is checked BEFORE (4) on purpose: a locked challenge stays
 * locked regardless of whether the submitted code happens to be right.
 */
export function evaluateChallenge(input: {
  readonly challenge: OtpChallenge
  readonly codeMatches: boolean
  readonly now: Date
}): Result<OtpChallenge, OtpFailure> {
  const { challenge, codeMatches, now } = input

  if (challenge.consumedAt !== null) return err({ kind: 'already_consumed' })

  if (challenge.expiresAt.getTime() <= now.getTime()) return err({ kind: 'expired' })

  if (challenge.attempts >= challenge.maxAttempts) return err({ kind: 'attempts_exhausted' })

  if (!codeMatches) {
    const attemptsRemaining = challenge.maxAttempts - (challenge.attempts + 1)
    return attemptsRemaining <= 0
      ? err({ kind: 'attempts_exhausted' })
      : err({ kind: 'code_mismatch', attemptsRemaining })
  }

  return ok(challenge)
}

/**
 * When a challenge issued at `now` should expire.
 *
 * Trivial, but it lives here rather than inline in the use-case so that expiry
 * is computed in exactly one place — a second, subtly different calculation
 * elsewhere is how "the code expired early" bugs start.
 */
export function expiryFrom(now: Date, expirySeconds: number): Date {
  /**
   * The `no-restricted-globals` ban on `Date` exists to stop domain code READING
   * the wall clock. Constructing a Date from an instant that was passed in is
   * arithmetic, not a clock read — but the rule matches the global identifier
   * and cannot tell the two call forms apart, so the exemption is made here
   * explicitly rather than by weakening the rule everywhere.
   */
  // eslint-disable-next-line no-restricted-globals -- derived from `now`, not read from the clock
  return new Date(now.getTime() + expirySeconds * 1000)
}

/**
 * Normalise a destination for storage and comparison.
 *
 * Email is case-insensitive in practice, and a user who signs up as
 * `Founder@Example.com` must be able to sign in as `founder@example.com`.
 * Without this, they get "no account found" and file a support ticket.
 *
 * Applied on BOTH write and lookup — normalising only one side is worse than
 * not normalising at all, because it fails asymmetrically and intermittently.
 */
export function normaliseDestination(destination: string): string {
  return destination.trim().toLowerCase()
}

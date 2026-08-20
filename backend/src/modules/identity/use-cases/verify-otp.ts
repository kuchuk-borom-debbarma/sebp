import type { Clock } from '@/ports/clock'
import type { CodeHasher } from '@/ports/code-hasher'
import { err, ok, type Result } from '@/shared/result'
import type { IdentityError } from '../domain/errors'
import {
  evaluateChallenge,
  normaliseDestination,
  type OtpPurpose,
} from '../domain/otp-challenge'
import type { OtpChallengeRepo } from '../ports/otp-challenge-repo'

/**
 * Verify and CONSUME a one-time code.
 *
 * Shared by complete-signup and reset-password — both need exactly this
 * sequence, and duplicating it would be how the two drift apart and one quietly
 * loses its attempt limiting.
 *
 * RULE ENFORCED: a code is valid at most once, before expiry, within the attempt
 * limit, and only for the purpose it was issued for.
 *
 * ERRORS RETURNED: `otp` (with the specific failure), `infrastructure`.
 *
 * ── SECURITY PROPERTIES ─────────────────────────────────────────────────────
 *
 * SINGLE USE is enforced by a CONDITIONAL update in the repository, not by
 * reading `consumedAt` and then writing. D1 has no interactive transactions, so
 * a read-then-write would let two concurrent submissions of the same valid code
 * both succeed. `consume()` reports whether it won; the loser is rejected.
 *
 * ATTEMPT COUNTING happens on a wrong code and NOT on expiry or an absent
 * challenge — otherwise an attacker could exhaust a legitimate user's attempts
 * by spamming codes at an address, locking them out. Expiry is checked before
 * attempts for the same reason (see evaluateChallenge).
 *
 * CONSTANT-TIME COMPARISON is the CodeHasher's responsibility. The submitted
 * code is attacker-controlled and compared against a secret, so an early-exit
 * comparison would leak the digest one character at a time.
 */

export type VerifyOtpDeps = {
  readonly repo: OtpChallengeRepo
  readonly hasher: CodeHasher
  readonly clock: Clock
}

export type VerifyOtpInput = {
  readonly destination: string
  readonly purpose: OtpPurpose
  readonly code: string
}

/** The verified, normalised destination — proven to be under the caller's control. */
export type VerifiedDestination = { readonly destination: string }

export function verifyOtp(deps: VerifyOtpDeps) {
  return async (
    input: VerifyOtpInput,
  ): Promise<Result<VerifiedDestination, IdentityError>> => {
    const { repo, hasher, clock } = deps
    const destination = normaliseDestination(input.destination)
    const now = clock.now()

    const found = await repo.findActive(destination, input.purpose)
    if (!found.ok) {
      return err({ kind: 'infrastructure', source: 'repo', reason: found.error.reason })
    }

    const challenge = found.value
    if (challenge === null) {
      // Reported to the caller identically to a wrong code — see the HTTP layer.
      return err({ kind: 'otp', failure: { kind: 'not_found' } })
    }

    const compared = await hasher.verify(input.code, challenge.codeHash)
    if (!compared.ok) {
      return err({ kind: 'infrastructure', source: 'hasher', reason: compared.error.reason })
    }

    const decision = evaluateChallenge({
      challenge,
      codeMatches: compared.value,
      now,
    })

    if (!decision.ok) {
      /**
       * Burn an attempt ONLY on a genuine wrong guess. Expiry, prior
       * consumption, and existing lockout must not consume attempts — see the
       * lockout-by-proxy note above.
       */
      if (decision.error.kind === 'code_mismatch' || decision.error.kind === 'attempts_exhausted') {
        const bumped = await repo.incrementAttempts(challenge.id)
        if (!bumped.ok) {
          return err({ kind: 'infrastructure', source: 'repo', reason: bumped.error.reason })
        }
      }
      return err({ kind: 'otp', failure: decision.error })
    }

    const consumed = await repo.consume(challenge.id, now)
    if (!consumed.ok) {
      return err({ kind: 'infrastructure', source: 'repo', reason: consumed.error.reason })
    }
    if (!consumed.value) {
      // Lost the race — another request consumed this challenge first.
      return err({ kind: 'otp', failure: { kind: 'already_consumed' } })
    }

    return ok({ destination })
  }
}

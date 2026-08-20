import { err, ok, type Result } from '@/shared/result'
import type { UserId } from '@/shared/ids'
import type { IdentityError } from '../domain/errors'
import type { OtpChallengeRepo } from '../ports/otp-challenge-repo'
import type { Accounts } from '../ports/accounts'
import type { verifyOtp } from './verify-otp'

/**
 * Create an account: OTP and password submitted together, in one call.
 *
 * RULE ENFORCED: an account exists only once the caller has BOTH proven control
 * of the address and chosen a password. There is no intermediate state — a
 * half-finished signup leaves nothing behind to clean up or exploit.
 *
 * ERRORS RETURNED: `otp`, `weak_password`, `already_registered`, `infrastructure`.
 *
 * ── WHY THERE IS NO SEPARATE EMAIL-VERIFICATION STEP ────────────────────────
 * Entering a valid OTP already proves the address. A second "confirm your email"
 * message would be redundant, and it would be sent by better-auth's own mailer,
 * bypassing the Notifier port that makes the console adapter and Pingram
 * interchangeable.
 *
 * ── ORDER MATTERS ───────────────────────────────────────────────────────────
 * Password policy is checked FIRST, before the OTP is consumed. Consuming a
 * single-use code and then rejecting the password would burn the code and force
 * the user to request another — a genuinely infuriating way to fail.
 */

export type CompleteSignupDeps = {
  readonly verify: ReturnType<typeof verifyOtp>
  readonly accounts: Accounts
  readonly repo: OtpChallengeRepo
  readonly passwordMinLength: number
}

export type CompleteSignupInput = {
  readonly email: string
  readonly code: string
  readonly password: string
}

export type SignupSuccess = { readonly userId: UserId; readonly setCookie: string }

export function completeSignup(deps: CompleteSignupDeps) {
  return async (
    input: CompleteSignupInput,
  ): Promise<Result<SignupSuccess, IdentityError>> => {
    const { verify, accounts, repo, passwordMinLength } = deps

    // Before consuming the code — see "order matters" above.
    if (input.password.length < passwordMinLength) {
      return err({ kind: 'weak_password', minLength: passwordMinLength })
    }

    const verified = await verify({
      destination: input.email,
      purpose: 'signup',
      code: input.code,
    })
    if (!verified.ok) return verified

    const created = await accounts.signUp({
      email: verified.value.destination,
      password: input.password,
    })

    if (!created.ok) {
      if (created.error.kind === 'already_registered') {
        return err({ kind: 'already_registered' })
      }
      // `already_registered` was handled above, so `failed` is the only kind
      // left — no ternary needed, and no unreachable branch.
      return err({ kind: 'infrastructure', source: 'auth', reason: created.error.reason })
    }

    /**
     * Clear every remaining signup challenge for this address. The consumed one
     * is already spent; any others were superseded. Leaving live credentials
     * lying around after they are no longer needed is pure downside.
     *
     * A failure here is NOT surfaced: the account exists and the user is signed
     * in. Failing the request now would tell them signup failed when it did not,
     * and they would be unable to retry because the account already exists.
     * Stale rows expire on their own.
     */
    await repo.deleteFor(verified.value.destination, 'signup')

    return ok({ userId: created.value.userId, setCookie: created.value.setCookie })
  }
}

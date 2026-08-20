import { err, ok, type Result } from '@/shared/result'
import type { IdentityError } from '../domain/errors'
import type { OtpChallengeRepo } from '../ports/otp-challenge-repo'
import type { Accounts } from '../ports/accounts'
import type { verifyOtp } from './verify-otp'

/**
 * Set a new password after proving control of the address by OTP.
 *
 * RULE ENFORCED: the same single-use, expiring, attempt-limited code machinery
 * as signup — reset is not a weaker path into an account.
 *
 * ERRORS RETURNED: `otp`, `weak_password`, `account_not_found`, `infrastructure`.
 *
 * Password policy is checked BEFORE the code is consumed, for the same reason as
 * signup: burning a single-use code and then rejecting the password would force
 * the user to request a fresh one.
 */

export type ResetPasswordDeps = {
  readonly verify: ReturnType<typeof verifyOtp>
  readonly accounts: Accounts
  readonly repo: OtpChallengeRepo
  readonly passwordMinLength: number
}

export type ResetPasswordInput = {
  readonly email: string
  readonly code: string
  readonly password: string
}

export function resetPassword(deps: ResetPasswordDeps) {
  return async (input: ResetPasswordInput): Promise<Result<void, IdentityError>> => {
    const { verify, accounts, repo, passwordMinLength } = deps

    if (input.password.length < passwordMinLength) {
      return err({ kind: 'weak_password', minLength: passwordMinLength })
    }

    const verified = await verify({
      destination: input.email,
      purpose: 'password_reset',
      code: input.code,
    })
    if (!verified.ok) return verified

    const updated = await accounts.setPassword({
      email: verified.value.destination,
      newPassword: input.password,
    })

    if (!updated.ok) {
      /**
       * Reaching here means a code was issued and verified for an address with
       * no account. request-otp issues codes without checking existence — by
       * design, so it cannot be used to enumerate accounts — so this is the
       * point where that shows up. It is safe to report now: the caller has
       * already proven they control the address.
       */
      if (updated.error.kind === 'not_found') return err({ kind: 'account_not_found' })
      // `not_found` was handled above, so `failed` is all that remains.
      return err({ kind: 'infrastructure', source: 'auth', reason: updated.error.reason })
    }

    // Invalidate any other outstanding reset codes for this address.
    await repo.deleteFor(verified.value.destination, 'password_reset')

    return ok(undefined)
  }
}

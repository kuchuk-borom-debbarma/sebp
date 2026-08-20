import { err, ok, type Result } from '@/shared/result'
import type { UserId } from '@/shared/ids'
import type { IdentityError } from '../domain/errors'
import { normaliseDestination } from '../domain/otp-challenge'
import type { Accounts } from '../ports/accounts'

/**
 * Sign in with email and password.
 *
 * RULE ENFORCED: credentials are checked by better-auth (native scrypt on
 * workerd — see the instance adapter for the measured cost).
 *
 * ERRORS RETURNED: `invalid_credentials`, `infrastructure`.
 *
 * ── WHY SIGN-IN IS PASSWORD-ONLY AND NOT OTP ────────────────────────────────
 * OTP is a signup and recovery mechanism here, deliberately not a login one. If
 * every sign-in required a delivered code, a mail outage would lock out every
 * existing user — including programme staff mid-review, at exactly the moment
 * they need to be working.
 *
 * ── NO ENUMERATION ──────────────────────────────────────────────────────────
 * "No such account" and "wrong password" are the SAME error. Distinguishing them
 * would let anyone discover which founders have applied by probing addresses.
 */

export type SignInDeps = {
  readonly accounts: Accounts
}

export type SignInInput = { readonly email: string; readonly password: string }

export type SignInSuccess = { readonly userId: UserId; readonly setCookie: string }

export function signIn(deps: SignInDeps) {
  return async (input: SignInInput): Promise<Result<SignInSuccess, IdentityError>> => {
    const result = await deps.accounts.signIn({
      email: normaliseDestination(input.email),
      password: input.password,
    })

    if (!result.ok) {
      return result.error.kind === 'failed'
        ? err({ kind: 'infrastructure', source: 'auth', reason: result.error.reason })
        : err({ kind: 'invalid_credentials' })
    }

    return ok({ userId: result.value.userId, setCookie: result.value.setCookie })
  }
}

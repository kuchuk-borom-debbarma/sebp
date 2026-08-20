import type { UserId } from '@/shared/ids'
import type { Result } from '@/shared/result'

/**
 * Account and session operations, as this module sees them.
 *
 * WHY A PORT: use-cases must depend on an interface, never on the adapter that
 * happens to implement it. This one exists because the ESLint rule enforcing
 * that caught the violation — the use-cases originally imported the better-auth
 * adapter directly, which would have leaked the library's shape into the layer
 * that is supposed to be independent of it.
 *
 * Everything here speaks OUR vocabulary: a branded {@link UserId}, a Result, and
 * a Set-Cookie string. Nothing better-auth-shaped crosses this boundary, which
 * is what keeps the cost of replacing it to one adapter directory.
 */

export type AccountError =
  | { kind: 'already_registered' }
  | { kind: 'invalid_credentials' }
  | { kind: 'not_found' }
  /** The auth backend itself failed — an outage, not a credential problem. */
  | { kind: 'failed'; reason: string }

/** A created or resumed session, ready to hand to the client. */
export type SessionResult = {
  readonly userId: UserId
  /** Set-Cookie header value, forwarded verbatim to the response. */
  readonly setCookie: string
}

/** signUp can only fail in these two ways. */
export type SignUpError = Extract<AccountError, { kind: 'already_registered' } | { kind: 'failed' }>
/** signIn can only fail in these two ways. */
export type SignInError = Extract<AccountError, { kind: 'invalid_credentials' } | { kind: 'failed' }>
/** setPassword can only fail in these two ways. */
export type SetPasswordError = Extract<AccountError, { kind: 'not_found' } | { kind: 'failed' }>

export interface Accounts {
  /**
   * Create an account with a password. Called ONLY after an OTP has proven
   * control of the address, so the email is trusted by this point.
   */
  signUp(input: {
    email: string
    password: string
  }): Promise<Result<SessionResult, SignUpError>>

  signIn(input: {
    email: string
    password: string
  }): Promise<Result<SessionResult, SignInError>>

  /** Change a password after an OTP has proven control of the address. */
  setPassword(input: {
    email: string
    newPassword: string
  }): Promise<Result<void, SetPasswordError>>
}

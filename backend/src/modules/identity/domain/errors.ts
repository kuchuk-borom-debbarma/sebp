import type { OtpFailure } from './otp-challenge'

/**
 * Everything that can go wrong in the identity module, as values.
 *
 * The HTTP layer maps these to status codes in ONE place
 * (http/middleware/error.ts) — never scattered through routes.
 */
export type IdentityError =
  /** OTP verification failed. See OtpFailure for the specific reason. */
  | { kind: 'otp'; failure: OtpFailure }
  /** Too many OTP requests for this address or from this IP. */
  | { kind: 'rate_limited'; retryAfterSeconds: number }
  /** Signup attempted for an address that already has an account. */
  | { kind: 'already_registered' }
  /** Sign-in credentials rejected. Deliberately says nothing about WHICH part. */
  | { kind: 'invalid_credentials' }
  /** Password failed policy (currently: minimum length). */
  | { kind: 'weak_password'; minLength: number }
  /** Password reset requested for an address with no account. */
  | { kind: 'account_not_found' }
  /*
   * NOTE: there was an `unauthenticated` kind here. It was deleted because no
   * route emits it — there is no /me route and no auth middleware yet, so the
   * branch was unreachable and the coverage gate flagged it as dead. Add it back
   * WITH the route that needs it, not before.
   */
  /**
   * An underlying service failed — database, notifier, rate limiter, better-auth.
   * These are the branches no HTTP request can force, which is why tests reach
   * them by substituting a failing port (CONVE-16).
   */
  | { kind: 'infrastructure'; source: string; reason: string }

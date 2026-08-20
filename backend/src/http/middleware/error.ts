import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { IdentityError } from '@/modules/identity'

/**
 * The ONE place identity errors become HTTP responses.
 *
 * Mapping lives here rather than in routes so that a status code is decided once
 * per error kind. Scattered mapping is how the same failure ends up as a 400 in
 * one endpoint and a 422 in another, and how enumeration leaks creep in — one
 * handler helpfully distinguishing "no such account" from "wrong password"
 * while its neighbour does not.
 */

type Mapped = {
  status: ContentfulStatusCode
  error: string
  message: string
  headers?: Record<string, string>
}

/**
 * ── ENUMERATION RESISTANCE ──────────────────────────────────────────────────
 * Every OTP failure that could reveal whether an address has a pending
 * challenge collapses into ONE response: `invalid_code`, 400. Internally the
 * domain distinguishes `not_found` from `code_mismatch` so it knows whether to
 * burn an attempt — but the caller must not be able to tell them apart, or the
 * endpoint becomes a way to discover which founders have applied.
 *
 * `expired` and `attempts_exhausted` ARE distinguished, deliberately. Both are
 * only reachable by someone who already holds a real code for that address, so
 * they reveal nothing new — and telling a legitimate user "your code expired"
 * rather than "wrong code" is the difference between them requesting a new one
 * and them filing a support ticket.
 */
function mapOtpFailure(failure: Extract<IdentityError, { kind: 'otp' }>['failure']): Mapped {
  switch (failure.kind) {
    case 'expired':
      return {
        status: 410,
        error: 'code_expired',
        message: 'That code has expired. Request a new one.',
      }
    case 'attempts_exhausted':
      return {
        status: 429,
        error: 'too_many_attempts',
        message: 'Too many incorrect attempts. Request a new code.',
      }
    case 'not_found':
    case 'already_consumed':
    case 'code_mismatch':
      // Deliberately indistinguishable — see the note above.
      return {
        status: 400,
        error: 'invalid_code',
        message: 'That code is not valid.',
      }
  }
}

export function mapIdentityError(error: IdentityError): Mapped {
  switch (error.kind) {
    case 'otp':
      return mapOtpFailure(error.failure)

    case 'rate_limited':
      return {
        status: 429,
        error: 'rate_limited',
        message: 'Too many requests. Try again shortly.',
        headers: { 'Retry-After': String(error.retryAfterSeconds) },
      }

    case 'already_registered':
      return {
        status: 409,
        error: 'already_registered',
        message: 'An account already exists for that email.',
      }

    case 'invalid_credentials':
      return {
        status: 401,
        error: 'invalid_credentials',
        message: 'Email or password is incorrect.',
      }

    case 'weak_password':
      return {
        status: 422,
        error: 'weak_password',
        message: `Password must be at least ${error.minLength} characters.`,
      }

    case 'account_not_found':
      return {
        status: 404,
        error: 'account_not_found',
        message: 'No account exists for that email.',
      }

    case 'infrastructure':
      /**
       * `reason` is NOT sent to the client. It can carry database messages and
       * internal detail; it belongs in logs, not in a response body. The client
       * gets a generic 503 and the operator gets the specifics.
       */
      return {
        status: 503,
        error: 'service_unavailable',
        message: 'Something went wrong on our side. Please try again.',
      }
  }
}

/**
 * TYPE NOTE — the one cast in this codebase, deliberately placed here.
 *
 * `@hono/zod-openapi` types a handler's return as the union of the statuses
 * DECLARED on that specific route. This helper picks its status dynamically from
 * the error kind, so TypeScript cannot narrow it to those literals.
 *
 * Every status this function can produce IS declared on every route that can
 * reach it — that is asserted by the e2e tests, which exercise each mapping
 * through a real request. Containing the cast at this single seam is better than
 * scattering per-route casts through handlers, where one would eventually hide a
 * genuine mismatch.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see TYPE NOTE above
export function respondWithError(c: Context, error: IdentityError): any {
  const mapped = mapIdentityError(error)

  if (error.kind === 'infrastructure') {
    // eslint-disable-next-line no-console -- operator-facing detail, never sent to the client
    console.error(`[identity] ${error.source} failed: ${error.reason}`)
  }

  return c.json(
    { error: mapped.error, message: mapped.message },
    mapped.status,
    mapped.headers ?? {},
  )
}

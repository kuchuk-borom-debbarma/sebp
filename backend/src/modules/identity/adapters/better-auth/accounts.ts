import { asUserId } from '@/shared/ids'
import { err, ok, type Result } from '@/shared/result'
import type {
  AccountError,
  Accounts,
  SessionResult,
  SetPasswordError,
  SignInError,
  SignUpError,
} from '../../ports/accounts'
import type { Auth } from './instance'

/**
 * The seam between better-auth and everything else.
 *
 * This file translates better-auth's API and types into OUR vocabulary: a
 * branded {@link UserId}, a Result, and a Set-Cookie header. Nothing downstream
 * ever sees a better-auth type, which is what keeps the blast radius of
 * replacing it to this directory plus one middleware file
 * (docs/codebase-structure.md §7).
 *
 * better-auth exposes its operations as HTTP handlers rather than plain
 * functions, so calls are made by constructing a Request. That is its designed
 * interface, not a workaround.
 */

type AuthUser = { id: string; email: string }

const asFailed = (cause: unknown): Extract<AccountError, { kind: 'failed' }> => ({
  kind: 'failed',
  reason: cause instanceof Error ? cause.message : String(cause),
})

function post(path: string, body: unknown, origin: string): Request {
  return new Request(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export function accountOperations(auth: Auth, origin: string): Accounts {
  return {
    /**
     * Create an account with a password. Called only AFTER the OTP has proven
     * control of the address, so the email is trusted at this point.
     */
    async signUp(input: {
      email: string
      password: string
    }): Promise<Result<SessionResult, SignUpError>> {
      try {
        const res = await auth.handler(
          post('/api/auth/sign-up/email', {
            email: input.email,
            password: input.password,
            name: input.email,
          }, origin),
        )

        if (!res.ok) {
          const detail = await res.text()
          // better-auth reports a duplicate as a 4xx; distinguishing it lets the
          // route return 409 rather than a generic failure.
          if (/exist|unique|already/i.test(detail)) return err({ kind: 'already_registered' })
          return err({ kind: 'failed', reason: `${res.status}: ${detail}` })
        }

        return readSession(res)
      } catch (cause) {
        return err(asFailed(cause))
      }
    },

    async signIn(input: {
      email: string
      password: string
    }): Promise<Result<SessionResult, SignInError>> {
      try {
        const res = await auth.handler(
          post('/api/auth/sign-in/email', input, origin),
        )

        /**
         * 4xx collapses to `invalid_credentials`, 5xx does not.
         *
         * All CLIENT errors are reported identically — distinguishing "no such
         * account" from "wrong password" would let anyone enumerate which
         * founders have signed up.
         *
         * But a SERVER error is not a credential problem. Collapsing it too
         * would tell a user with a perfectly good password that it was wrong
         * whenever the database was down — sending them to reset a password
         * that was never the issue, and hiding a real outage behind a plausible
         * 401. Caught by the infrastructure-failure tests.
         */
        if (res.status >= 500) {
          return err({ kind: 'failed', reason: `${res.status}: ${await res.text()}` })
        }
        if (!res.ok) return err({ kind: 'invalid_credentials' })

        return readSession(res)
      } catch (cause) {
        return err(asFailed(cause))
      }
    },

    /** Change a password after the OTP has proven control of the address. */
    async setPassword(input: {
      email: string
      newPassword: string
    }): Promise<Result<void, SetPasswordError>> {
      try {
        const user = await findUserByEmail(auth, input.email)
        if (user === null) return err({ kind: 'not_found' })

        const ctx = await auth.$context
        const hashed = await ctx.password.hash(input.newPassword)
        await ctx.internalAdapter.updatePassword(user.id, hashed)

        return ok(undefined)
      } catch (cause) {
        return err(asFailed(cause))
      }
    },

  }
}

async function findUserByEmail(auth: Auth, email: string): Promise<AuthUser | null> {
  const ctx = await auth.$context
  const found = await ctx.internalAdapter.findUserByEmail(email)
  if (found === null || found === undefined) return null
  return { id: found.user.id, email: found.user.email }
}

async function readSession(
  res: Response,
): Promise<Result<SessionResult, Extract<AccountError, { kind: 'failed' }>>> {
  const setCookie = res.headers.get('set-cookie')
  if (setCookie === null) {
    return err({ kind: 'failed', reason: 'auth response carried no session cookie' })
  }

  const body = (await res.json()) as { user?: { id?: string } }
  const id = body.user?.id
  if (id === undefined) {
    return err({ kind: 'failed', reason: 'auth response carried no user id' })
  }

  return ok({ userId: asUserId(id), setCookie })
}

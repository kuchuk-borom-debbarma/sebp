import type { Config } from '@/config'
import type { Database } from '@/platform/d1/client'
import type { Clock } from '@/ports/clock'
import type { CodeHasher } from '@/ports/code-hasher'
import type { IdGenerator } from '@/ports/id-generator'
import type { Notifier } from '@/ports/notifier'
import type { RateLimiter } from '@/ports/rate-limiter'
import type { Random } from '@/ports/random'
import { accountOperations } from './adapters/better-auth/accounts'
import { createAuth, type Auth } from './adapters/better-auth/instance'
import { d1OtpChallengeRepo } from './adapters/d1/otp-challenge-repo'
import type { OtpChallengeRepo } from './ports/otp-challenge-repo'
import { completeSignup } from './use-cases/complete-signup'
import { requestOtp } from './use-cases/request-otp'
import { resetPassword } from './use-cases/reset-password'
import { signIn } from './use-cases/sign-in'
import { verifyOtp } from './use-cases/verify-otp'

/**
 * Assembles the identity module from platform ports.
 *
 * Called ONLY by the composition root. Concrete adapters are constructed here
 * and nowhere else — no route, no use-case, and no test helper may `new` one
 * (docs/codebase-structure.md §10).
 */
export type IdentityDeps = {
  readonly db: Database
  readonly config: Config
  readonly clock: Clock
  readonly ids: IdGenerator
  readonly random: Random
  readonly hasher: CodeHasher
  readonly notifier: Notifier
  readonly limiter: RateLimiter
  /** Origin used when invoking better-auth's HTTP-shaped handlers. */
  readonly origin: string
  /**
   * Failure-injection seam for tests only. No HTTP request can force a database
   * error on demand, so the repository's error branches are otherwise
   * unreachable. Permitted under CONVE-16 for failure paths; NEVER for a happy
   * path.
   */
  readonly repo?: OtpChallengeRepo
  /**
   * Failure-injection seam for tests only. better-auth's response-shape guards
   * (missing session cookie, missing user id) protect against it changing
   * between versions, and cannot be provoked through HTTP.
   */
  readonly auth?: Auth
}

export function createIdentityModule(deps: IdentityDeps) {
  const { db, config, clock, ids, random, hasher, notifier, limiter, origin } = deps

  const repo = deps.repo ?? d1OtpChallengeRepo(db)
  const auth = deps.auth ?? createAuth(db, config, ids)
  const accounts = accountOperations(auth, origin)

  const verify = verifyOtp({ repo, hasher, clock })

  return {
    auth,
    useCases: {
      requestOtp: requestOtp({
        repo,
        notifier,
        limiter,
        hasher,
        random,
        ids,
        clock,
        config: {
          codeLength: config.otp.codeLength,
          expirySeconds: config.otp.expirySeconds,
          maxAttempts: config.otp.maxAttempts,
          perEmail: config.rateLimit.otpPerEmail,
          perIp: config.rateLimit.otpPerIp,
          windowSeconds: config.rateLimit.windowSeconds,
        },
      }),
      completeSignup: completeSignup({
        verify,
        accounts,
        repo,
        passwordMinLength: config.password.minLength,
      }),
      signIn: signIn({ accounts }),
      resetPassword: resetPassword({
        verify,
        accounts,
        repo,
        passwordMinLength: config.password.minLength,
      }),
    },
  }
}

export type IdentityModule = ReturnType<typeof createIdentityModule>

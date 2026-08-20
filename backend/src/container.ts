import { loadConfig, type Config } from './config'
import { createDatabase, type Database } from './platform/d1/client'
import { systemClock } from './platform/clock'
import { uuidV7Generator } from './platform/ids'
import { webCryptoRandom } from './platform/random'
import { hmacCodeHasher } from './platform/hasher'
import { kvRateLimiter } from './platform/kv/rate-limiter'
import { consoleNotifier, type ConsoleNotifier } from './platform/notifier/console'
import type { Notifier } from './ports/notifier'
import type { RateLimiter } from './ports/rate-limiter'
import type { Clock } from './ports/clock'
import type { CodeHasher } from './ports/code-hasher'
import type { OtpChallengeRepo, IdentityDeps } from './modules/identity'
import { createIdentityModule, type IdentityModule } from './modules/identity'

/**
 * COMPOSITION ROOT — the only place concrete adapters are constructed.
 *
 * No route, no use-case, and no test helper may `new` an adapter
 * (docs/codebase-structure.md §10). This file is the seam that makes every port
 * swappable: changing the notifier from console to Pingram is one line HERE and
 * zero lines anywhere else.
 */

export type Container = {
  readonly config: Config
  readonly identity: IdentityModule
  /**
   * Exposed ONLY so tests can read delivered messages out of the console
   * adapter. Undefined whenever a real provider is configured.
   *
   * This is the real configured adapter being inspected — not a substituted
   * port — which is what keeps it inside CONVE-16's rule that substitution is
   * for failure paths only.
   */
  readonly consoleNotifier?: ConsoleNotifier
}

/**
 * Overrides exist so tests can reach branches NO HTTP REQUEST CAN FORCE.
 *
 * Permitted (CONVE-16):
 *   - a Notifier or RateLimiter that FAILS, to exercise infrastructure branches
 *   - a Clock offset into the future, to exercise OTP expiry without a test that
 *     genuinely waits ten minutes
 *
 * FORBIDDEN: substituting any port to make a happy path easier or faster. A
 * substituted port on a success path is a rule violation and will be rejected in
 * review — the whole value of HTTP-level testing is that the real adapters run.
 */
export type ContainerOverrides = {
  readonly notifier?: Notifier
  readonly limiter?: RateLimiter
  readonly clock?: Clock
  /** Force the OTP repository to fail. */
  readonly otpRepo?: OtpChallengeRepo
  /** Force hashing to fail, or inject a throwing WebCrypto. */
  readonly hasher?: CodeHasher
  readonly subtle?: SubtleCrypto
  /** Raw KV binding, so the rate limiter's own catch branch is reachable. */
  readonly kv?: KVNamespace
  /** Force better-auth to return a malformed response. */
  readonly auth?: IdentityDeps['auth']
  /** Raw Drizzle client, so the repository's own catch branches are reachable. */
  readonly db?: Database
}

export function buildContainer(
  env: Env,
  origin: string,
  overrides: ContainerOverrides = {},
): Container {
  // Throws ConfigError on anything missing or malformed, and refuses to boot
  // with a console notifier or wildcard CORS in production.
  const config = loadConfig(env)

  const db = overrides.db ?? createDatabase(env.DB)
  const clock = overrides.clock ?? systemClock()
  const ids = uuidV7Generator()
  const random = webCryptoRandom()
  const hasher = overrides.hasher ?? hmacCodeHasher(config.otp.pepper, overrides.subtle)
  const limiter = overrides.limiter ?? kvRateLimiter(overrides.kv ?? env.CACHE, clock)

  const console_ =
    config.notifier.driver === 'console' ? consoleNotifier(clock, ids) : undefined

  const notifier: Notifier =
    overrides.notifier ??
    console_ ??
    // The Pingram adapter is not built yet. Reaching here means
    // NOTIFIER_DRIVER=pingram was set before it exists — fail loudly at boot
    // rather than silently dropping every message.
    (() => {
      throw new Error(
        `NOTIFIER_DRIVER=${config.notifier.driver} is not implemented yet. ` +
          'Only "console" is available until the Pingram adapter lands.',
      )
    })()

  const identity = createIdentityModule({
    db,
    config,
    clock,
    ids,
    random,
    hasher,
    notifier,
    limiter,
    origin,
    ...(overrides.otpRepo === undefined ? {} : { repo: overrides.otpRepo }),
    ...(overrides.auth === undefined ? {} : { auth: overrides.auth }),
  })

  return { config, identity, ...(console_ === undefined ? {} : { consoleNotifier: console_ }) }
}

import { z } from 'zod'

/**
 * Typed, validated, frozen configuration.
 *
 * Nothing tunable is hardcoded anywhere else in the codebase. Every value here
 * comes from the environment, is validated at boot, and fails LOUDLY if missing
 * or malformed — a bad config should stop the Worker, not surface three days
 * later as a strange runtime bug.
 *
 * On Workers there is no `process.env`: variables arrive on the `env` object
 * handed to `fetch`. `loadConfig` is therefore called once from the composition
 * root and memoised per isolate (see `getConfig`).
 *
 * Config failure THROWS rather than returning a Result. That is deliberate and
 * consistent with the error model in docs/codebase-structure.md §8: a Result
 * models a failure the caller can act on, and a misdeployed secret is not one.
 * It is a deployment bug, and it should read like one.
 */

/** Coerce "true"/"false" strings, since every Workers binding arrives as text. */
const boolish = z
  .union([z.boolean(), z.enum(['true', 'false'])])
  .transform((v) => v === true || v === 'true')

/** A positive integer arriving as a string binding. */
const positiveInt = z.coerce.number().int().positive()

const EnvSchema = z.object({
  ENVIRONMENT: z.enum(['development', 'staging', 'production']),

  // ── OTP ──────────────────────────────────────────────────────────────────
  OTP_CODE_LENGTH: positiveInt.min(4).max(10).default(6),
  OTP_EXPIRY_SECONDS: positiveInt.default(600),
  OTP_MAX_ATTEMPTS: positiveInt.default(5),
  /**
   * HMAC key for hashing OTP codes before storage. A 6-digit code has only 10^6
   * possibilities, so a bare hash is brute-forced instantly — the pepper is what
   * makes a database leak insufficient to recover live codes.
   *
   * Minimum length is enforced because a short pepper defeats the purpose.
   */
  OTP_PEPPER: z.string().min(32, 'OTP_PEPPER must be at least 32 characters — generate with `openssl rand -hex 32`'),

  // ── Notifications ────────────────────────────────────────────────────────
  NOTIFIER_DRIVER: z.enum(['console', 'pingram']).default('console'),

  // ── Rate limiting ────────────────────────────────────────────────────────
  RATE_LIMIT_OTP_PER_EMAIL: positiveInt.default(3),
  RATE_LIMIT_OTP_PER_IP: positiveInt.default(10),
  RATE_LIMIT_OTP_WINDOW_SECONDS: positiveInt.default(3600),

  // ── Sessions ─────────────────────────────────────────────────────────────
  BETTER_AUTH_SECRET: z.string().min(32, 'BETTER_AUTH_SECRET must be at least 32 characters'),
  SESSION_TTL_SECONDS: positiveInt.default(604_800),
  /**
   * Empty for localhost — browsers reject a Domain attribute of "localhost".
   * In production this is the PARENT domain (".sebp.com") so the SSR frontend
   * and this API share one session cookie.
   */
  SESSION_COOKIE_DOMAIN: z.string().default(''),

  // ── HTTP ─────────────────────────────────────────────────────────────────
  CORS_ALLOWED_ORIGINS: z.string().default(''),
  SWAGGER_ENABLED: boolish.default(false),

  /** Length beats composition rules; there is deliberately no symbol/case requirement. */
  PASSWORD_MIN_LENGTH: positiveInt.min(8).default(10),
})

export type Environment = z.infer<typeof EnvSchema>['ENVIRONMENT']
export type NotifierDriver = z.infer<typeof EnvSchema>['NOTIFIER_DRIVER']

export type Config = Readonly<{
  environment: Environment
  isProduction: boolean
  otp: Readonly<{
    codeLength: number
    expirySeconds: number
    maxAttempts: number
    pepper: string
  }>
  notifier: Readonly<{ driver: NotifierDriver }>
  rateLimit: Readonly<{
    otpPerEmail: number
    otpPerIp: number
    windowSeconds: number
  }>
  session: Readonly<{
    secret: string
    ttlSeconds: number
    cookieDomain: string
  }>
  http: Readonly<{
    corsAllowedOrigins: readonly string[]
    swaggerEnabled: boolean
  }>
  password: Readonly<{ minLength: number }>
}>

/** Thrown when the environment is missing or malformed. Always a deployment bug. */
export class ConfigError extends Error {
  override readonly name = 'ConfigError'
}

/**
 * Guards that refuse to boot rather than warn.
 *
 * Both of these are configurations that "work" — the Worker would serve traffic
 * quite happily — while being seriously wrong. A warning in a log nobody reads
 * is not adequate protection for either.
 */
function assertProductionSafety(config: Config): void {
  if (!config.isProduction) return

  if (config.notifier.driver === 'console') {
    throw new ConfigError(
      'NOTIFIER_DRIVER=console is refused in production. The console notifier ' +
        'prints OTP codes to stdout and delivers nothing — signup would silently ' +
        'break while live credentials leaked into logs.',
    )
  }

  if (config.http.corsAllowedOrigins.includes('*')) {
    throw new ConfigError(
      'CORS_ALLOWED_ORIGINS=* is refused in production. Credentials are enabled ' +
        'because the session is a cookie, so a wildcard origin would let any site ' +
        'make authenticated requests on a user behalf.',
    )
  }
}

/**
 * Parse and validate the environment. Throws {@link ConfigError} on any problem,
 * with every failing field named — debugging a deployment should not require
 * bisecting variables one at a time.
 */
export function loadConfig(env: unknown): Config {
  const parsed = EnvSchema.safeParse(env)

  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n')
    throw new ConfigError(`Invalid environment configuration:\n${problems}`)
  }

  const e = parsed.data

  const config: Config = Object.freeze({
    environment: e.ENVIRONMENT,
    isProduction: e.ENVIRONMENT === 'production',
    otp: Object.freeze({
      codeLength: e.OTP_CODE_LENGTH,
      expirySeconds: e.OTP_EXPIRY_SECONDS,
      maxAttempts: e.OTP_MAX_ATTEMPTS,
      pepper: e.OTP_PEPPER,
    }),
    notifier: Object.freeze({ driver: e.NOTIFIER_DRIVER }),
    rateLimit: Object.freeze({
      otpPerEmail: e.RATE_LIMIT_OTP_PER_EMAIL,
      otpPerIp: e.RATE_LIMIT_OTP_PER_IP,
      windowSeconds: e.RATE_LIMIT_OTP_WINDOW_SECONDS,
    }),
    session: Object.freeze({
      secret: e.BETTER_AUTH_SECRET,
      ttlSeconds: e.SESSION_TTL_SECONDS,
      cookieDomain: e.SESSION_COOKIE_DOMAIN,
    }),
    http: Object.freeze({
      corsAllowedOrigins: Object.freeze(
        e.CORS_ALLOWED_ORIGINS.split(',')
          .map((o) => o.trim())
          .filter((o) => o.length > 0),
      ),
      swaggerEnabled: e.SWAGGER_ENABLED,
    }),
    password: Object.freeze({ minLength: e.PASSWORD_MIN_LENGTH }),
  })

  assertProductionSafety(config)

  return config
}

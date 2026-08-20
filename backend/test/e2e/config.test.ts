import { describe, expect, it } from 'vitest'
import { ConfigError, loadConfig } from '@/config'

/**
 * The config layer is exercised directly rather than through HTTP.
 *
 * This is the ONE deliberate exception to the HTTP-only rule, and it is not a
 * convenience: the guards below REFUSE TO BOOT. There is no running server to
 * send a request to, because the failure happens before one exists. Reaching
 * them through HTTP is not merely awkward, it is impossible by construction.
 *
 * Every other test in this suite goes through a real request.
 */

const valid = {
  ENVIRONMENT: 'production',
  OTP_PEPPER: 'x'.repeat(32),
  BETTER_AUTH_SECRET: 'y'.repeat(32),
  NOTIFIER_DRIVER: 'pingram',
  CORS_ALLOWED_ORIGINS: 'https://app.sebp.com',
}

describe('config validation', () => {
  it('accepts a complete production environment', () => {
    const config = loadConfig(valid)

    expect(config.isProduction).toBe(true)
    expect(config.http.corsAllowedOrigins).toEqual(['https://app.sebp.com'])
    // Defaults fill in for anything not explicitly set.
    expect(config.otp.codeLength).toBe(6)
    expect(config.otp.expirySeconds).toBe(600)
  })

  it('names every failing field at once', () => {
    // Debugging a deployment should not mean bisecting variables one at a time.
    try {
      loadConfig({ ENVIRONMENT: 'production' })
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError)
      const message = (e as ConfigError).message
      expect(message).toContain('OTP_PEPPER')
      expect(message).toContain('BETTER_AUTH_SECRET')
    }
  })

  it('rejects an unknown environment name', () => {
    expect(() => loadConfig({ ...valid, ENVIRONMENT: 'staging-2' })).toThrow(ConfigError)
  })

  it('rejects a pepper too short to be worth having', () => {
    // A short pepper defeats the point: the whole reason OTP codes are HMAC'd
    // rather than hashed is that the key is not guessable.
    expect(() => loadConfig({ ...valid, OTP_PEPPER: 'too-short' })).toThrow(/at least 32/)
  })

  it('coerces numeric and boolean bindings, which always arrive as strings', () => {
    const config = loadConfig({
      ...valid,
      OTP_CODE_LENGTH: '8',
      OTP_EXPIRY_SECONDS: '90',
      SWAGGER_ENABLED: 'true',
    })

    expect(config.otp.codeLength).toBe(8)
    expect(config.otp.expirySeconds).toBe(90)
    expect(config.http.swaggerEnabled).toBe(true)
  })

  it('trims and drops empty entries from the CORS list', () => {
    const config = loadConfig({
      ...valid,
      CORS_ALLOWED_ORIGINS: ' https://a.example.com , ,https://b.example.com ',
    })

    expect(config.http.corsAllowedOrigins).toEqual([
      'https://a.example.com',
      'https://b.example.com',
    ])
  })

  it('freezes the result so nothing can mutate config at runtime', () => {
    const config = loadConfig(valid)
    expect(Object.isFrozen(config)).toBe(true)
    expect(Object.isFrozen(config.otp)).toBe(true)
  })
})

describe('production boot guards', () => {
  it('REFUSES to boot with the console notifier in production', () => {
    // The console adapter prints live OTP codes to stdout and delivers nothing.
    // Shipping it would silently break signup while leaking credentials to logs.
    expect(() => loadConfig({ ...valid, NOTIFIER_DRIVER: 'console' })).toThrow(
      /console is refused in production/,
    )
  })

  it('REFUSES to boot with wildcard CORS in production', () => {
    // Credentials are enabled because the session is a cookie, so `*` would let
    // any site make authenticated requests on a user's behalf.
    expect(() => loadConfig({ ...valid, CORS_ALLOWED_ORIGINS: '*' })).toThrow(
      /refused in production/,
    )
  })

  it('allows both outside production, which is the point of them', () => {
    const dev = loadConfig({
      ...valid,
      ENVIRONMENT: 'development',
      NOTIFIER_DRIVER: 'console',
      CORS_ALLOWED_ORIGINS: '*',
    })

    expect(dev.isProduction).toBe(false)
    expect(dev.notifier.driver).toBe('console')
  })
})

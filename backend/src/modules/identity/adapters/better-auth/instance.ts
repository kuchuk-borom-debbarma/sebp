import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import type { Config } from '@/config'
import type { Database } from '@/platform/d1/client'
import type { IdGenerator } from '@/ports/id-generator'
import { betterAuthSchema } from './schema'

/**
 * The better-auth instance. THIS FILE AND ITS SIBLINGS ARE THE ONLY PLACE
 * OUTSIDE http/middleware/auth.ts THAT MAY IMPORT better-auth (CONVE-15,
 * docs/codebase-structure.md §7). dependency-cruiser enforces it.
 *
 * ── WHAT BETTER-AUTH OWNS ───────────────────────────────────────────────────
 * user / session / account / verification tables, password hashing, and session
 * issue + validation. That is all.
 *
 * ── WHAT IT DOES NOT OWN ────────────────────────────────────────────────────
 * The OTP mechanism. We own that (modules/identity/domain + otp_challenges),
 * because better-auth's OTP plugin would deliver mail through its own mailer,
 * bypassing the Notifier port — and the Notifier port is precisely what lets the
 * console adapter work in development and Pingram drop in later. Its flow also
 * assumes verify-then-register, where sebp needs OTP and password submitted
 * together in one call.
 *
 * ── PASSWORD HASHING (verified in TASK-39) ──────────────────────────────────
 * better-auth uses scrypt, NOT bcrypt. `@better-auth/utils` declares a `workerd`
 * export condition pointing at the native `node:crypto` implementation, so
 * Workers gets native scrypt rather than the pure-JS fallback. This REQUIRES
 * `compatibility_flags = ["nodejs_compat"]` in wrangler.toml — without it the
 * module does not resolve and the build fails.
 *
 * Measured on workerd: ~67ms per hash, ~47ms per verify.
 *
 * Parameters are N=16384, r=16, p=1 → 128 * N * r = 32MB of memory per
 * operation, against a 128MB isolate limit. Twelve concurrent operations were
 * fine locally, but watch memory under concurrent signup load on staging.
 */
export function createAuth(db: Database, config: Config, ids: IdGenerator) {
  return betterAuth({
    secret: config.session.secret,
    // The schema is passed EXPLICITLY rather than merged into the main Drizzle
    // client, so better-auth's tables stay confined to this directory and do
    // not appear alongside ours (see ./schema.ts).
    database: drizzleAdapter(db, { provider: 'sqlite', schema: betterAuthSchema }),

    emailAndPassword: {
      enabled: true,
      minPasswordLength: config.password.minLength,
      /**
       * OFF deliberately. Entering a valid OTP already proves the address, so a
       * second verification email would be redundant noise — and it would be
       * sent by better-auth's mailer, outside our Notifier port.
       */
      requireEmailVerification: false,
      /**
       * `sendResetPassword` is intentionally NOT set. better-auth's built-in
       * reset flow is unused — reset runs through our own OTP machinery so the
       * message goes out via the Notifier port like every other message.
       * (`exactOptionalPropertyTypes` means omitting the key and setting it to
       * `undefined` are different things; it must be omitted.)
       */
    },

    session: {
      expiresIn: config.session.ttlSeconds,
      /** Refresh the expiry when a session is used within a day of lapsing. */
      updateAge: 60 * 60 * 24,
    },

    advanced: {
      /**
       * Ids come from OUR IdGenerator (UUIDv7) so every table in sebp shares one
       * id strategy and stays time-sortable.
       *
       * GOTCHA: `generateId: false` does NOT mean "we supply them" — it means
       * "the database supplies them", which on SQLite with a TEXT primary key
       * and no default results in `NOT NULL constraint failed: user.id`. A
       * function is what hands better-auth an id to use.
       */
      database: { generateId: () => ids.next() },
      ...(config.session.cookieDomain === ''
        ? {}
        : {
            crossSubDomainCookies: {
              enabled: true,
              domain: config.session.cookieDomain,
            },
          }),
    },

    /** Trusted origins mirror CORS: the SSR frontend calls this API directly. */
    trustedOrigins: [...config.http.corsAllowedOrigins],
  })
}

export type Auth = ReturnType<typeof createAuth>

import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * One outstanding one-time-code challenge.
 *
 * SQLite has no `COMMENT ON`, so column documentation lives here and in the
 * migration SQL — those are the two places anyone actually reads.
 *
 * THE ONLY TABLE WITHOUT `version` / `deleted_at`. Every other table in sebp
 * carries optimistic-concurrency versioning and soft deletion; a spent OTP
 * challenge is genuinely deleted instead. Retaining expired credentials is a
 * liability rather than an audit trail, and the audit of "who signed up when"
 * lives on the user record, not here.
 */
export const otpChallenges = sqliteTable(
  'otp_challenges',
  {
    /** UUIDv7 from the IdGenerator port — time-sortable, never DB-generated. */
    id: text('id').primaryKey(),

    /** 'signup' | 'password_reset'. Scopes lookups so one cannot satisfy the other. */
    purpose: text('purpose').notNull(),

    /** 'email' | 'sms'. sms is unused until phone verification lands. */
    channel: text('channel').notNull(),

    /**
     * Email address today, phone number later. Deliberately NOT named "email" —
     * renaming a column later is a migration; naming it right now is free.
     */
    destination: text('destination').notNull(),

    /**
     * HMAC-SHA256(code, OTP_PEPPER) as hex. NEVER the code itself.
     * A 6-digit code has 10^6 possibilities, so a bare hash would be reversed
     * instantly from a database leak; the pepper is what makes the leak
     * insufficient on its own.
     */
    codeHash: text('code_hash').notNull(),

    /** Wrong guesses so far. Compared against maxAttempts, then locked. */
    attempts: integer('attempts').notNull().default(0),

    /**
     * Snapshot of OTP_MAX_ATTEMPTS at issue time, NOT read live from config.
     * Changing the limit must not retroactively lock out — or silently unlock —
     * a challenge already in flight.
     */
    maxAttempts: integer('max_attempts').notNull(),

    /** ISO-8601 UTC. Compared against the Clock port, never against Date.now(). */
    expiresAt: text('expires_at').notNull(),

    /** Set on successful verification. A consumed challenge can never be reused. */
    consumedAt: text('consumed_at'),

    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    /**
     * Every verification looks up by (destination, purpose) and wants the newest
     * unconsumed row. Without this index that is a full scan on the hottest path
     * in the auth flow.
     */
    index('idx_otp_lookup').on(t.destination, t.purpose, t.consumedAt),
  ],
)

export type OtpChallengeRow = typeof otpChallenges.$inferSelect
export type NewOtpChallengeRow = typeof otpChallenges.$inferInsert

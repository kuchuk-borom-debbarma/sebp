import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * better-auth's OWN tables, as Drizzle definitions.
 *
 * ⚠️  THESE ARE NOT OUR TABLES. Shapes are dictated by better-auth 1.7.1 and
 * were derived from its `getAuthTables()` output, not written from memory. On
 * upgrade, re-derive and diff rather than assuming stability.
 *
 * ── WHY THEY LIVE HERE AND NOT IN platform/d1/schema/ ───────────────────────
 * Our shared Drizzle schema is for tables sebp owns. Putting better-auth's
 * tables there would make them look like ours and invite other modules to query
 * them directly — precisely what the confinement rule exists to prevent
 * (CONVE-15, docs/codebase-structure.md §7). Keeping them inside the better-auth
 * adapter directory means the blast radius of replacing better-auth stays this
 * directory plus one middleware file.
 *
 * They are passed explicitly to `drizzleAdapter({ schema })` rather than being
 * merged into the main Drizzle client's schema.
 *
 * ── CONVENTIONS DELIBERATELY NOT FOLLOWED ───────────────────────────────────
 * No `version`, no `deleted_at`, singular table names, camelCase columns. sebp's
 * own tables follow sebp's conventions; these follow better-auth's. That
 * mismatch is a consequence of the exception, not an oversight.
 *
 * SQLite has no date or boolean type: dates are INTEGER epoch-millis via
 * drizzle's `timestamp` mode, booleans INTEGER 0/1.
 */

export const user = sqliteTable('user', {
  /** Supplied by our IdGenerator (UUIDv7) — `generateId: false` in the instance. */
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  /**
   * Always true in sebp: an account cannot exist until an OTP has proven the
   * address, so there is no unverified state to represent.
   */
  emailVerified: integer('emailVerified', { mode: 'boolean' }).notNull().default(false),
  image: text('image'),
  createdAt: integer('createdAt', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updatedAt', { mode: 'timestamp' }).notNull(),
})

export const session = sqliteTable('session', {
  id: text('id').primaryKey(),
  expiresAt: integer('expiresAt', { mode: 'timestamp' }).notNull(),
  /**
   * The opaque value carried in the session cookie. Server-side sessions rather
   * than JWTs, specifically so staff access can be revoked immediately.
   */
  token: text('token').notNull().unique(),
  createdAt: integer('createdAt', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updatedAt', { mode: 'timestamp' }).notNull(),
  ipAddress: text('ipAddress'),
  userAgent: text('userAgent'),
  userId: text('userId')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
})

export const account = sqliteTable('account', {
  id: text('id').primaryKey(),
  issuer: text('issuer').notNull(),
  accountId: text('accountId').notNull(),
  /** 'credential' for email+password. sebp has no OAuth providers. */
  providerId: text('providerId').notNull(),
  userId: text('userId')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('accessToken'),
  refreshToken: text('refreshToken'),
  idToken: text('idToken'),
  accessTokenExpiresAt: integer('accessTokenExpiresAt', { mode: 'timestamp' }),
  refreshTokenExpiresAt: integer('refreshTokenExpiresAt', { mode: 'timestamp' }),
  scope: text('scope'),
  /**
   * scrypt hash as `salt:key` hex — 161 characters (measured in TASK-39).
   * N=16384, r=16, p=1. NOT bcrypt, which is unavailable on Workers.
   */
  password: text('password'),
  createdAt: integer('createdAt', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updatedAt', { mode: 'timestamp' }).notNull(),
})

/**
 * Created because better-auth expects it to exist. sebp does NOT use it — OTP
 * lives in our own `otp_challenges` table so delivery goes through the Notifier
 * port. It should remain empty in normal operation.
 */
export const verification = sqliteTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: integer('expiresAt', { mode: 'timestamp' }).notNull(),
  createdAt: integer('createdAt', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updatedAt', { mode: 'timestamp' }).notNull(),
})

/** The schema object handed to `drizzleAdapter`. */
export const betterAuthSchema = { user, session, account, verification }

/**
 * Drizzle table definitions, one file per module's tables.
 *
 * Schema is PROGRESSIVE: tables arrive with the module that needs them, not up
 * front. technical-design.md §4 is the target model to design against, not a
 * migration plan. Today only identity's tables exist.
 *
 * better-auth's own tables (user, session, account, verification) are NOT
 * defined here — it owns them and generates their migration itself. See
 * docs/codebase-structure.md §7 for why that exception exists.
 */
export * from './otp-challenges'

import { drizzle } from 'drizzle-orm/d1'
import * as schema from './schema'

/**
 * The Drizzle client over a D1 binding.
 *
 * WRAPS: a Cloudflare D1 database binding.
 *
 * ── QUIRKS THAT MATTER ──────────────────────────────────────────────────────
 *
 * 1. NO INTERACTIVE TRANSACTIONS. D1 does not support `BEGIN`/`COMMIT` across
 *    awaits, so drizzle's `db.transaction()` is NOT available. Multi-statement
 *    atomicity uses `db.batch([...])`, which runs statements in one round trip
 *    and rolls back together. Anything needing read-then-write atomicity must
 *    use a conditional UPDATE and check `meta.changes` instead — that is how
 *    optimistic concurrency is enforced (technical-design.md §5.6).
 *
 * 2. SQLITE TYPES ARE NARROW. No native date/boolean. Timestamps are ISO-8601
 *    TEXT (sortable as strings, unambiguous in UTC), booleans are INTEGER 0/1.
 *
 * 3. NO `COMMENT ON`. Column documentation lives in the drizzle schema and the
 *    migration SQL. This is a SQLite limitation, not an oversight.
 */
export type Database = ReturnType<typeof createDatabase>

export function createDatabase(binding: D1Database) {
  return drizzle(binding, { schema })
}

export { schema }

import type { Config } from 'drizzle-kit'

/**
 * Generates migration SQL from the drizzle schema.
 *
 * `dialect: 'sqlite'` — D1 speaks SQLite. Generated SQL is reviewed and
 * committed under migrations/, then applied by wrangler, never by drizzle-kit
 * directly (D1 has no direct connection to push to).
 */
export default {
  schema: './src/platform/d1/schema/index.ts',
  out: './migrations',
  dialect: 'sqlite',
} satisfies Config

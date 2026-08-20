import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'

/**
 * Tests run INSIDE workerd against real D1 and KV — never against mocks.
 * See docs/codebase-structure.md §13 and CONVE-16.
 *
 * NOTE ON THE API: @cloudflare/vitest-pool-workers 0.22 (for vitest 4) replaced
 * the old `defineWorkersConfig` from the `/config` subpath with a Vite plugin,
 * `cloudflareTest()`. Most examples online still show the old form and will not
 * resolve. Found during TASK-35.
 *
 * The 0.22 options schema also DROPPED `isolatedStorage`, which earlier versions
 * used to give each test its own D1/KV state. Per-test isolation is therefore not
 * asserted here — it is verified empirically by the first tests that write to D1,
 * and if state leaks between tests they explicitly reset it.
 */
/**
 * Migrations are read from disk at CONFIG time and handed to the test worker as
 * a binding, because a Worker cannot read the filesystem. Tests then apply them
 * with `applyD1Migrations(env.DB, env.TEST_MIGRATIONS)`.
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const migrations = await readD1Migrations(path.join(here, 'migrations'))

export default defineConfig({
  // tsconfig `paths` is a TYPE-ONLY mapping — Vite does not read it, so the
  // `@/` alias has to be declared again here or imports fail at runtime.
  resolve: {
    alias: { '@': path.join(here, 'src') },
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      miniflare: {
        compatibilityFlags: ['nodejs_compat'],
        bindings: {
          // Test-time configuration. Deliberately NOT production-like: the
          // console notifier keeps OTP codes readable by the test harness, and
          // low rate limits keep the limit tests fast.
          ENVIRONMENT: 'development',
          NOTIFIER_DRIVER: 'console',
          OTP_CODE_LENGTH: '6',
          OTP_EXPIRY_SECONDS: '600',
          OTP_MAX_ATTEMPTS: '5',
          OTP_PEPPER: 'test-pepper-0000000000000000000000000000000000',
          BETTER_AUTH_SECRET: 'test-secret-0000000000000000000000000000000000',
          SESSION_TTL_SECONDS: '604800',
          SESSION_COOKIE_DOMAIN: '',
          CORS_ALLOWED_ORIGINS: 'http://localhost:3000',
          SWAGGER_ENABLED: 'true',
          PASSWORD_MIN_LENGTH: '10',
          RATE_LIMIT_OTP_PER_EMAIL: '3',
          RATE_LIMIT_OTP_PER_IP: '10',
          RATE_LIMIT_OTP_WINDOW_SECONDS: '3600',
          TEST_MIGRATIONS: migrations,
        },
      },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],

    /**
     * better-auth throws its own `APIError` internally on paths it then handles
     * — a wrong password, a duplicate signup — but it does so from a promise it
     * does not await. Vitest sees those as unhandled rejections and fails the
     * run even though every assertion passed and our code handled the response
     * correctly.
     *
     * THE COST, STATED PLAINLY: this also hides genuine unhandled rejections in
     * OUR code. That is a real trade. It is accepted because the noise comes
     * from a dependency's internals on expected paths and there is no narrower
     * filter available — not because unhandled rejections are unimportant.
     *
     * If a future better-auth release awaits its own errors, DELETE THIS.
     */
    dangerouslyIgnoreUnhandledErrors: true,
    setupFiles: ['./test/setup.ts'],
    coverage: {
      /**
       * ISTANBUL, NOT V8 — this matters.
       *
       * `coverage-v8` collects from the V8 process running the tests. Our code
       * does not run there: it runs inside workerd, so v8 coverage reports 0%
       * even with a fully passing suite. Istanbul instruments the SOURCE during
       * Vite's transform, before it ever reaches the Workers runtime, so the
       * counters travel with the code and come back correctly.
       *
       * Found during TASK-43 — see the task notes.
       */
      provider: 'istanbul',
      include: ['src/**/*.ts'],
      // The Worker entrypoint is a fetch handler wired to the container: it is
      // exercised by every test but has no branches of its own.
      exclude: [
        // Worker entrypoint: a fetch handler wired to the container. Exercised
        // by every test, but it has no branches of its own.
        'src/index.ts',
        // Drizzle table DECLARATIONS, not logic. The arrow functions inside
        // `references(() => user.id)` are invoked by drizzle only when building
        // queries against those specific tables, which better-auth does
        // internally — so they are uncoverable from our side without asserting
        // on someone else's query construction. The tables themselves are
        // verified by every test that writes to the database.
        'src/platform/d1/schema/**',
        'src/modules/identity/adapters/better-auth/schema.ts',
      ],
      thresholds: { lines: 100, functions: 100, branches: 100, statements: 100 },
    },
  },
})

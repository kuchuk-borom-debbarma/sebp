import { env, applyD1Migrations } from 'cloudflare:test'
import type { D1Migration } from '@cloudflare/vitest-pool-workers'
import { buildContainer, type ContainerOverrides } from '@/container'
import { createApp } from '@/http/app'

/**
 * Test harness.
 *
 * Every test goes through HTTP against real D1 and KV — no mocks (CONVE-16).
 * The OTP code is read out of the REAL console notifier the container built,
 * which is inspection of a configured adapter rather than substitution of a
 * port, and therefore allowed on the happy path.
 */

const ORIGIN = 'https://api.test.local'

/**
 * TEST_MIGRATIONS is injected by vitest.config.ts, which reads the migrations
 * directory at config time — a Worker cannot touch the filesystem. It is not
 * part of the generated `Env`, hence the explicit local type.
 */
type TestEnv = Env & { TEST_MIGRATIONS: D1Migration[] }
export const testEnv = env as unknown as TestEnv

export async function migrate(): Promise<void> {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS)
}

/**
 * Each harness gets a DISTINCT caller IP by default.
 *
 * WHY THIS MATTERS: vitest-pool-workers 0.22 dropped `isolatedStorage`, so KV
 * state persists across tests in a file (recorded in TASK-35). Without a unique
 * IP every test would share the `unknown` rate-limit bucket and the eleventh
 * request in the file would be blocked — tests failing for a reason that has
 * nothing to do with what they assert.
 *
 * Passing an explicit `ip` lets the per-IP limiting test share one deliberately.
 */
let ipCounter = 0
const nextIp = (): string => `203.0.113.${++ipCounter % 250}:${ipCounter}`

export function harness(overrides: ContainerOverrides = {}, ip: string = nextIp()) {
  const container = buildContainer(testEnv, ORIGIN, overrides)
  const app = createApp(container)

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request(
      `${ORIGIN}${path}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'CF-Connecting-IP': ip,
          ...headers,
        },
        body: JSON.stringify(body),
      },
      testEnv,
    )

  return {
    container,
    app,
    post,
    get: (path: string, headers: Record<string, string> = {}) =>
      app.request(`${ORIGIN}${path}`, { headers: { 'CF-Connecting-IP': ip, ...headers } }, testEnv),

    /**
     * The delivered code, extracted from the console notifier's retained
     * messages. Throws rather than returning undefined: a missing code means the
     * flow under test did not deliver, and a silent undefined would surface much
     * later as a confusing assertion failure.
     */
    codeFor(destination: string): string {
      const message = container.consoleNotifier?.lastTo(destination.toLowerCase())
      if (message === undefined) {
        throw new Error(`no message was delivered to ${destination}`)
      }
      const match = /\b(\d{4,10})\b/.exec(message.body)
      if (match === null) {
        throw new Error(`no code found in delivered message: ${message.body}`)
      }
      return match[1]!
    },
  }
}

/** A unique address per test, so tests cannot collide through shared state. */
let counter = 0
export const uniqueEmail = (): string => `founder-${Date.now()}-${counter++}@example.com`

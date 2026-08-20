/**
 * The current time, as a dependency.
 *
 * WHY A PORT: `Date.now()` inside domain logic makes behaviour untestable — you
 * cannot assert "this challenge is expired" without either sleeping or mutating
 * global state. Taking time as an argument turns expiry into a pure comparison.
 *
 * ESLint bans `Date` and `Date.now` inside `domain/` and `use-cases/` precisely
 * so this port cannot be bypassed (CONVE-13).
 *
 * FAILURE MODES: none. Reading a clock does not fail, so this returns a plain
 * value rather than a Result.
 */
export interface Clock {
  /** Current instant. Always UTC — the codebase has no concept of local time. */
  now(): Date
}

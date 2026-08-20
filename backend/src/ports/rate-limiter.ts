import type { Result } from '@/shared/result'

/** The limiter's own storage failed — distinct from "the caller is over limit". */
export type RateLimiterError = { kind: 'limiter_unavailable'; reason: string }

export type RateLimitDecision = {
  readonly allowed: boolean
  /** Requests still permitted in the current window. Zero once blocked. */
  readonly remaining: number
  /** When the window resets. Surfaced to the caller as `Retry-After`. */
  readonly resetAt: Date
}

/**
 * Fixed-window request counting.
 *
 * WHY IT EXISTS: an unrated OTP endpoint sends an email to anyone who asks. That
 * is free email for an attacker, a bill for us, and — worse — a fast route to
 * having our sending domain flagged as a spam source, at which point real
 * decision emails start landing in junk.
 *
 * WHY A PORT: today it counts in KV. If it ever needs to be Durable Objects (for
 * strict consistency) or a Cloudflare Rate Limiting binding, that is an adapter
 * swap.
 *
 * NOTE ON SEMANTICS: a fixed window is approximate — a caller can burst across a
 * window boundary. That is accepted deliberately; the goal is preventing abuse
 * at scale, not exact fairness, and exactness would cost a Durable Object per
 * key. Documented here so nobody "fixes" it without understanding the trade.
 */
export interface RateLimiter {
  /**
   * Record one attempt against `key` and report whether it is allowed.
   *
   * Consumes quota as a side effect — callers must not call it speculatively.
   */
  consume(
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<Result<RateLimitDecision, RateLimiterError>>
}

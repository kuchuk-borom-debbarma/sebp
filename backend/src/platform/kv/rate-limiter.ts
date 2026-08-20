import type { RateLimitDecision, RateLimiter, RateLimiterError } from '@/ports/rate-limiter'
import type { Clock } from '@/ports/clock'
import { err, ok, type Result } from '@/shared/result'

/**
 * Implements {@link RateLimiter} with a fixed window counted in Workers KV.
 *
 * WRAPS: a KV namespace binding.
 *
 * HOW: the key embeds the window number (`floor(now / windowSeconds)`), so a new
 * window uses a new key and the old one expires on its own. There is no reset
 * job and no cleanup — expiry is the cleanup.
 *
 * ── QUIRKS THAT MATTER ──────────────────────────────────────────────────────
 *
 * 1. KV IS EVENTUALLY CONSISTENT. Reads may serve a value up to ~60s stale, and
 *    concurrent increments can be lost to last-write-wins. A determined attacker
 *    hitting many edge locations at once can therefore exceed the nominal limit.
 *    This is ACCEPTED: the goal is stopping casual abuse and runaway loops
 *    cheaply, not airtight quota enforcement. Strict counting needs a Durable
 *    Object per key, which is a real cost per OTP request.
 *
 * 2. KV MINIMUM TTL IS 60 SECONDS. A shorter window still stores a 60s entry,
 *    which only ever over-restricts (the key outlives its window), never
 *    under-restricts. Safe direction to fail in.
 *
 * 3. FAILURE IS NOT SILENT. If KV is unavailable this returns an error rather
 *    than defaulting to "allowed". The caller decides — and for OTP the caller
 *    refuses the request, because a broken limiter plus an open endpoint is
 *    exactly the combination that produces a five-figure email bill.
 */
export function kvRateLimiter(kv: KVNamespace, clock: Clock): RateLimiter {
  return {
    async consume(
      key: string,
      limit: number,
      windowSeconds: number,
    ): Promise<Result<RateLimitDecision, RateLimiterError>> {
      const nowMs = clock.now().getTime()
      const windowIndex = Math.floor(nowMs / (windowSeconds * 1000))
      const windowKey = `rl:${key}:${windowIndex}`
      const resetAt = new Date((windowIndex + 1) * windowSeconds * 1000)

      try {
        const raw = await kv.get(windowKey)
        const used = raw === null ? 0 : Number.parseInt(raw, 10)

        // A corrupted value must not disable the limit. Treat unparseable as
        // exhausted: fail closed, not open.
        const current = Number.isNaN(used) ? limit : used

        if (current >= limit) {
          return ok({ allowed: false, remaining: 0, resetAt })
        }

        const next = current + 1
        await kv.put(windowKey, String(next), {
          expirationTtl: Math.max(60, windowSeconds), // see quirk 2
        })

        return ok({ allowed: true, remaining: limit - next, resetAt })
      } catch (cause) {
        return err({
          kind: 'limiter_unavailable',
          reason: cause instanceof Error ? cause.message : String(cause),
        })
      }
    },
  }
}

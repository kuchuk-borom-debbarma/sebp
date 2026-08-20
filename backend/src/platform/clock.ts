import type { Clock } from '@/ports/clock'

/**
 * Implements {@link Clock} using the runtime wall clock.
 *
 * WRAPS: the JS `Date` global.
 *
 * QUIRK WORTH KNOWING: Cloudflare Workers freeze `Date.now()` for the duration
 * of a request unless I/O occurs, as a Spectre mitigation. Two calls inside one
 * synchronous block therefore return the SAME instant. That is fine for us —
 * expiry is computed once per request — but it makes wall-clock timing of code
 * inside a single Worker invocation useless, so do not try.
 */
export const systemClock = (): Clock => ({
  now: () => new Date(),
})

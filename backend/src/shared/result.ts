/**
 * Failures are return values, not exceptions.
 *
 * WHY (docs/codebase-structure.md §8, CONVE-14): the coverage gate is 100% and
 * every test goes through HTTP. A `catch` block is one of the hardest branches
 * to reach from outside the process; a discriminated union is trivially
 * reachable and assertable. Making failure a value is what makes the gate
 * achievable rather than a fight.
 *
 * `throw` remains reserved for programmer error — a thrown error is a 500 and a
 * bug report, never a user-facing condition.
 */
export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E }

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value })
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error })

/**
 * No `isOk`/`isErr`/`mapOk`/`andThen` combinators here.
 *
 * Under a 100% coverage gate every unused helper is dead code that must either
 * be exercised by a test or deleted. Three of them were written and then deleted
 * for exactly that reason — helpers earn their place by being used. Call sites
 * check `.ok` directly, which narrows just as well.
 */

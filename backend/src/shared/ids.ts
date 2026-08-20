/**
 * Branded identifiers.
 *
 * A bare `string` for every id means `getUser(applicationId)` compiles happily.
 * Branding makes that a type error at no runtime cost — the brand exists only in
 * the type system.
 *
 * `UserId` matters most: it is the ONLY thing the rest of the codebase ever sees
 * of better-auth. Outside `modules/identity` and the auth middleware, no module
 * may import better-auth or reference its types (CONVE-15,
 * docs/codebase-structure.md §7). Everything downstream speaks `UserId`, which
 * is what keeps the blast radius of replacing better-auth to two files.
 */

declare const brand: unique symbol

type Branded<T, B extends string> = T & { readonly [brand]: B }

export type UserId = Branded<string, 'UserId'>
export type OtpChallengeId = Branded<string, 'OtpChallengeId'>

/**
 * Brand constructors.
 *
 * These are unchecked casts by design — validation belongs at the edge (Zod on
 * the way in, the database schema on the way out), not repeated at every brand
 * site. Their job is to mark the ONE place where an unbranded string becomes a
 * typed id, so those places are greppable.
 */
export const asUserId = (v: string): UserId => v as UserId
export const asOtpChallengeId = (v: string): OtpChallengeId => v as OtpChallengeId

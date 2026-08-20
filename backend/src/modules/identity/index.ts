/**
 * PUBLIC SURFACE of the identity module.
 *
 * From outside this directory the ONLY legal import path is
 * `@/modules/identity` — deep paths are a dependency-cruiser error, not a
 * review comment (CONVE-12).
 *
 * Note what is absent: no adapters, no routes, no better-auth types. Other
 * modules see a branded UserId and nothing more, which is what bounds the cost
 * of ever replacing better-auth (docs/codebase-structure.md §7).
 */
export type { OtpPurpose, OtpChannel, OtpFailure } from './domain/otp-challenge'
export type { IdentityError } from './domain/errors'
export type { OtpChallengeRepo } from './ports/otp-challenge-repo'
export { createIdentityModule, type IdentityModule, type IdentityDeps } from './module'

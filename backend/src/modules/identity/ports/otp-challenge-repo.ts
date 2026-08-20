import type { OtpChallenge, OtpPurpose } from '../domain/otp-challenge'
import type { Result } from '@/shared/result'

/** Persistence failed. Distinct from "no challenge exists", which is a null hit. */
export type RepoError = { kind: 'repo_failed'; reason: string }

/**
 * Persistence for OTP challenges. Owned by this module; implemented in
 * adapters/d1.
 *
 * Returns DOMAIN ENTITIES, never Drizzle rows — mapping happens in the adapter
 * and nowhere else (CONVE-13). That is what keeps the D1-to-Postgres escape
 * hatch in ADR 0001 real rather than aspirational.
 */
export interface OtpChallengeRepo {
  /**
   * The newest unconsumed challenge for this destination and purpose, or null.
   *
   * Newest-first matters: requesting a second code must supersede the first, or
   * a user who requests twice and types the code they just received gets told it
   * is wrong.
   */
  findActive(
    destination: string,
    purpose: OtpPurpose,
  ): Promise<Result<OtpChallenge | null, RepoError>>

  save(challenge: OtpChallenge): Promise<Result<void, RepoError>>

  /** Record a failed guess. Separate from save() so it is one narrow UPDATE. */
  incrementAttempts(id: OtpChallenge['id']): Promise<Result<void, RepoError>>

  /**
   * Mark consumed. MUST be conditional on the challenge still being unconsumed,
   * and MUST report whether it won — two requests submitting the same valid code
   * concurrently must not both succeed.
   *
   * Returns true if this call consumed it, false if it was already consumed.
   */
  consume(id: OtpChallenge['id'], at: Date): Promise<Result<boolean, RepoError>>

  /**
   * Delete every challenge for a destination and purpose.
   *
   * Called after a successful signup or reset. Spent credentials are a liability
   * with no audit value — this table is the one place in sebp that hard-deletes.
   */
  deleteFor(destination: string, purpose: OtpPurpose): Promise<Result<void, RepoError>>
}

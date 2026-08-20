import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import type { Database } from '@/platform/d1/client'
import { otpChallenges, type OtpChallengeRow } from '@/platform/d1/schema'
import { asOtpChallengeId } from '@/shared/ids'
import { err, ok, type Result } from '@/shared/result'
import type {
  OtpChallenge,
  OtpChannel,
  OtpPurpose,
} from '../../domain/otp-challenge'
import type { OtpChallengeRepo, RepoError } from '../../ports/otp-challenge-repo'

/**
 * D1 implementation of {@link OtpChallengeRepo}.
 *
 * Row-to-entity mapping happens HERE and nowhere else — a Drizzle row type must
 * never escape this directory (CONVE-13).
 */

/** SQLite has no date type; timestamps are ISO-8601 UTC text, sortable as strings. */
const toIso = (d: Date): string => d.toISOString()

function toDomain(row: OtpChallengeRow): OtpChallenge {
  return {
    id: asOtpChallengeId(row.id),
    purpose: row.purpose as OtpPurpose,
    channel: row.channel as OtpChannel,
    destination: row.destination,
    codeHash: row.codeHash,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    expiresAt: new Date(row.expiresAt),
    consumedAt: row.consumedAt === null ? null : new Date(row.consumedAt),
    createdAt: new Date(row.createdAt),
  }
}

const asRepoError = (cause: unknown): RepoError => ({
  kind: 'repo_failed',
  reason: cause instanceof Error ? cause.message : String(cause),
})

export function d1OtpChallengeRepo(db: Database): OtpChallengeRepo {
  return {
    async findActive(
      destination: string,
      purpose: OtpPurpose,
    ): Promise<Result<OtpChallenge | null, RepoError>> {
      try {
        const rows = await db
          .select()
          .from(otpChallenges)
          .where(
            and(
              eq(otpChallenges.destination, destination),
              eq(otpChallenges.purpose, purpose),
              isNull(otpChallenges.consumedAt),
            ),
          )
          // Newest first: a freshly requested code must supersede an older one.
          .orderBy(desc(otpChallenges.createdAt))
          .limit(1)

        const row = rows[0]
        return ok(row === undefined ? null : toDomain(row))
      } catch (cause) {
        return err(asRepoError(cause))
      }
    },

    async save(challenge: OtpChallenge): Promise<Result<void, RepoError>> {
      try {
        await db.insert(otpChallenges).values({
          id: challenge.id,
          purpose: challenge.purpose,
          channel: challenge.channel,
          destination: challenge.destination,
          codeHash: challenge.codeHash,
          attempts: challenge.attempts,
          maxAttempts: challenge.maxAttempts,
          expiresAt: toIso(challenge.expiresAt),
          /**
           * Always null. `save` inserts a NEW challenge and the only caller
           * (requestOtp) constructs it unconsumed, so the ternary that used to
           * be here had an unreachable side — it pretended save could persist an
           * already-consumed challenge. Consumption happens through `consume`,
           * which is conditional and reports whether it won.
           */
          consumedAt: null,
          createdAt: toIso(challenge.createdAt),
          updatedAt: toIso(challenge.createdAt),
        })
        return ok(undefined)
      } catch (cause) {
        return err(asRepoError(cause))
      }
    },

    async incrementAttempts(id: OtpChallenge['id']): Promise<Result<void, RepoError>> {
      try {
        /**
         * Incremented in SQL rather than read-modify-write. D1 has no
         * interactive transactions, so a read-then-write here would let two
         * concurrent wrong guesses both read `attempts = 2` and both write 3 —
         * handing an attacker a free extra attempt per race.
         */
        await db
          .update(otpChallenges)
          .set({
            attempts: sql`${otpChallenges.attempts} + 1`,
            updatedAt: sql`CURRENT_TIMESTAMP`,
          })
          .where(eq(otpChallenges.id, id))
        return ok(undefined)
      } catch (cause) {
        return err(asRepoError(cause))
      }
    },

    async consume(id: OtpChallenge['id'], at: Date): Promise<Result<boolean, RepoError>> {
      try {
        /**
         * CONDITIONAL on still being unconsumed, and the caller is told whether
         * it won. Two requests submitting the same valid code concurrently must
         * not both create an account — the loser sees `false` and is rejected.
         *
         * This is the same conditional-update pattern used for optimistic
         * concurrency elsewhere (technical-design.md §5.6); D1's lack of
         * interactive transactions makes it the only correct option.
         */
        const result = await db
          .update(otpChallenges)
          .set({ consumedAt: toIso(at), updatedAt: toIso(at) })
          .where(and(eq(otpChallenges.id, id), isNull(otpChallenges.consumedAt)))

        return ok((result.meta?.changes ?? 0) > 0)
      } catch (cause) {
        return err(asRepoError(cause))
      }
    },

    async deleteFor(
      destination: string,
      purpose: OtpPurpose,
    ): Promise<Result<void, RepoError>> {
      try {
        // The one table in sebp that hard-deletes. Spent credentials are a
        // liability, not an audit trail.
        await db
          .delete(otpChallenges)
          .where(
            and(
              eq(otpChallenges.destination, destination),
              eq(otpChallenges.purpose, purpose),
            ),
          )
        return ok(undefined)
      } catch (cause) {
        return err(asRepoError(cause))
      }
    },
  }
}

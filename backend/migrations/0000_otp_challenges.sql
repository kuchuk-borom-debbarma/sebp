-- ═══════════════════════════════════════════════════════════════════════════
-- otp_challenges
--
-- One outstanding one-time-code challenge, used for signup verification and
-- password reset.
--
-- SQLite has no COMMENT ON, so this file and the Drizzle schema
-- (src/platform/d1/schema/otp-challenges.ts) are where column documentation
-- lives. Keep them in step.
--
-- THIS IS THE ONLY TABLE IN sebp WITHOUT `version` AND `deleted_at`.
-- Every other table carries optimistic-concurrency versioning and soft
-- deletion. A spent OTP challenge is genuinely deleted instead: retaining
-- expired credentials is a liability, not an audit trail, and the record of
-- "who signed up when" belongs on the user, not here.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE `otp_challenges` (
	-- UUIDv7 from the IdGenerator port. Time-sortable, so rows cluster by
	-- creation order in the index rather than scattering. Never DB-generated.
	`id` text PRIMARY KEY NOT NULL,

	-- 'signup' | 'password_reset'. Scopes lookups, so a code issued for one
	-- purpose can never satisfy the other.
	`purpose` text NOT NULL,

	-- 'email' | 'sms'. Only 'email' is used today; 'sms' arrives with phone
	-- verification and needs no schema change when it does.
	`channel` text NOT NULL,

	-- Email address today, phone number later. Deliberately NOT named "email":
	-- naming it correctly now is free, renaming it later is a migration.
	-- Stored normalised (trimmed, lowercased) — see normaliseDestination().
	`destination` text NOT NULL,

	-- HMAC-SHA256(code, OTP_PEPPER) as hex. NEVER the code itself.
	-- A 6-digit code has only 10^6 possible values, so a bare hash would be
	-- reversed from a database leak in milliseconds. The pepper — held in
	-- Workers secrets, never in this database — is what makes the leak
	-- insufficient on its own.
	`code_hash` text NOT NULL,

	-- Wrong guesses so far. Incremented in SQL (attempts = attempts + 1), never
	-- read-modify-write: D1 has no interactive transactions, so a racing pair of
	-- wrong guesses would otherwise both write the same value and hand an
	-- attacker a free extra attempt.
	`attempts` integer DEFAULT 0 NOT NULL,

	-- Snapshot of OTP_MAX_ATTEMPTS at issue time, NOT read live at verify time.
	-- Changing the configured limit must not retroactively lock out — or
	-- silently unlock — a challenge already in flight.
	`max_attempts` integer NOT NULL,

	-- ISO-8601 UTC text. SQLite has no date type; ISO-8601 sorts correctly as a
	-- string and is unambiguous. Compared against the Clock port, never Date.now().
	`expires_at` text NOT NULL,

	-- Set on successful verification, by a CONDITIONAL update that also reports
	-- whether it won the race. This is what enforces single use: two requests
	-- submitting the same valid code concurrently cannot both succeed.
	`consumed_at` text,

	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
-- Every verification looks up by (destination, purpose) filtered to unconsumed
-- rows, newest first. Without this index that is a full table scan on the
-- hottest path in the auth flow.
CREATE INDEX `idx_otp_lookup` ON `otp_challenges` (`destination`,`purpose`,`consumed_at`);

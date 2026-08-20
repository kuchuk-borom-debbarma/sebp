import type { Result } from '@/shared/result'

/** Hashing failed. Always an infrastructure or misconfiguration problem. */
export type HasherError = { kind: 'hash_failed'; reason: string }

/**
 * One-way hashing and constant-time verification of short secrets (OTP codes).
 *
 * WHY A PORT: the domain must never touch WebCrypto directly, and the hashing
 * strategy should be replaceable without editing a single use-case.
 *
 * WHY HMAC RATHER THAN A PLAIN HASH: a 6-digit code has only 10^6 possible
 * values. A bare SHA-256 of it is reversed by brute force in milliseconds, so
 * storing one would be barely better than storing the code. Keying the hash with
 * a server-held pepper means a database leak alone does not yield live codes —
 * the attacker also needs the secret, which lives in Workers secrets.
 *
 * SECURITY PROPERTY — `verify` MUST be constant-time. Unlike better-auth's
 * password comparison (where the attacker cannot steer scrypt's output), the OTP
 * code here IS attacker-controlled and compared against a secret, so an
 * early-exit comparison leaks how many characters matched.
 */
export interface CodeHasher {
  /** Hash a code for storage. The result is safe to persist. */
  hash(code: string): Promise<Result<string, HasherError>>

  /**
   * Verify a candidate code against a stored hash, in constant time.
   *
   * Returns whether it matched — a non-match is NOT an error, it is an expected
   * outcome the caller acts on.
   */
  verify(code: string, storedHash: string): Promise<Result<boolean, HasherError>>
}

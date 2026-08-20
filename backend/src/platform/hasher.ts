import type { CodeHasher, HasherError } from '@/ports/code-hasher'
import { err, ok, type Result } from '@/shared/result'

/**
 * Implements {@link CodeHasher} using HMAC-SHA256 from WebCrypto.
 *
 * WRAPS: `crypto.subtle` (available on Workers without any compatibility flag).
 *
 * WHY HMAC AND NOT A PLAIN HASH — this is the important part.
 * A 6-digit OTP has 10^6 possible values. If we stored `SHA-256(code)`, anyone
 * with a copy of the database could enumerate all million hashes in well under a
 * second and recover every live code. Keying the digest with a server-held
 * pepper means the database alone is not enough: the attacker also needs
 * OTP_PEPPER, which lives in Workers secrets and never touches the database.
 *
 * This is NOT a password hash and deliberately not scrypt/argon2. Those are slow
 * by design to resist offline cracking of user-chosen secrets. An OTP is
 * server-generated, high-entropy relative to its tiny lifetime, single-use, and
 * attempt-limited — so the threat is database disclosure, which a pepper
 * addresses, not offline grinding, which slowness addresses. Using scrypt here
 * would add ~67ms per verification for no security gain.
 */
export function hmacCodeHasher(
  pepper: string,
  /**
   * The WebCrypto implementation, injected so tests can reach the failure
   * branches below. WebCrypto does not fail in normal operation, so without a
   * seam these `catch` blocks would be permanently uncoverable — and under a
   * 100% gate that leaves two bad options: delete the error handling, or ignore
   * the lines. Injecting the primitive is the honest third one.
   */
  subtle: SubtleCrypto = crypto.subtle,
): CodeHasher {
  const encoder = new TextEncoder()

  /**
   * The imported key is cached per adapter instance. Importing on every call
   * would repeat the work on the hot path for no benefit — the pepper is fixed
   * for the lifetime of the isolate.
   */
  let keyPromise: Promise<CryptoKey> | undefined

  const getKey = (): Promise<CryptoKey> => {
    keyPromise ??= subtle.importKey(
      'raw',
      encoder.encode(pepper),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    return keyPromise
  }

  const digest = async (code: string): Promise<string> => {
    const signature = await subtle.sign('HMAC', await getKey(), encoder.encode(code))
    return Array.from(new Uint8Array(signature), (b) => b.toString(16).padStart(2, '0')).join('')
  }

  const toHasherError = (cause: unknown): HasherError => ({
    kind: 'hash_failed',
    reason: cause instanceof Error ? cause.message : String(cause),
  })

  return {
    async hash(code: string): Promise<Result<string, HasherError>> {
      try {
        return ok(await digest(code))
      } catch (cause) {
        return err(toHasherError(cause))
      }
    },

    async verify(code: string, storedHash: string): Promise<Result<boolean, HasherError>> {
      try {
        const candidate = await digest(code)

        /**
         * SECURITY PROPERTY — CONSTANT TIME.
         * `candidate === storedHash` exits at the first differing character, so
         * the time taken reveals how many leading characters matched. Here the
         * compared value derives from ATTACKER-CONTROLLED input (the submitted
         * code) checked against a secret, so that leak is genuinely exploitable
         * — an attacker could walk the digest one character at a time.
         *
         * XOR-accumulate over the whole string instead: the work done is
         * identical whether the first character differs or none do.
         *
         * The length check is safe to short-circuit: HMAC-SHA256 output is
         * always 64 hex characters, so a length mismatch means a malformed
         * stored value, not a near-miss guess.
         */
        if (candidate.length !== storedHash.length) return ok(false)

        let diff = 0
        for (let i = 0; i < candidate.length; i++) {
          diff |= candidate.charCodeAt(i) ^ storedHash.charCodeAt(i)
        }

        return ok(diff === 0)
      } catch (cause) {
        return err(toHasherError(cause))
      }
    },
  }
}

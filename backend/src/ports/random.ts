/**
 * Cryptographically secure randomness, as a dependency.
 *
 * WHY A PORT: OTP codes must be unguessable. `Math.random()` is not suitable and
 * is banned inside domain/ and use-cases/ (CONVE-13); `crypto` is banned there
 * too, so secure randomness has to arrive through an interface.
 *
 * SECURITY PROPERTY: implementations MUST use a CSPRNG and MUST avoid modulo
 * bias when reducing bytes to a numeric range. A biased OTP generator narrows
 * the search space for an attacker without anyone noticing.
 *
 * FAILURE MODES: none in practice — WebCrypto's RNG does not fail on Workers.
 */
export interface Random {
  /**
   * A decimal string of exactly `length` digits, zero-padded, uniformly
   * distributed across the whole range (so "000123" is as likely as "912345").
   *
   * Returns a string rather than a number because leading zeros are significant
   * and a numeric type would silently discard them.
   */
  digits(length: number): string
}

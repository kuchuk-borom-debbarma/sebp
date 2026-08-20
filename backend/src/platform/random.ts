import type { Random } from '@/ports/random'

/**
 * Implements {@link Random} using WebCrypto.
 *
 * WRAPS: `crypto.getRandomValues`.
 *
 * SECURITY PROPERTY — REJECTION SAMPLING, NOT MODULO.
 * The obvious implementation is `bytes[i] % 10`. That is biased: 256 is not a
 * multiple of 10, so bytes 0-5 map to digits 0-5 more often than 6-9 map to
 * theirs. Across a 6-digit code that measurably shrinks the search space.
 *
 * Instead, any byte at or above the largest multiple of 10 that fits in a byte
 * (250) is DISCARDED and redrawn, so every digit is exactly equally likely.
 * The redraw probability is 6/256, so the loop is not a performance concern.
 */
export const webCryptoRandom = (): Random => ({
  digits(length: number): string {
    const LIMIT = 250 // floor(256 / 10) * 10
    let out = ''

    while (out.length < length) {
      // Over-draw so the common case needs a single syscall.
      const buf = new Uint8Array(length - out.length + 8)
      crypto.getRandomValues(buf)

      for (const byte of buf) {
        if (out.length === length) break
        if (byte >= LIMIT) continue // biased region — discard and redraw
        out += (byte % 10).toString()
      }
    }

    return out
  },
})

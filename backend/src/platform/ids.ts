import type { IdGenerator } from '@/ports/id-generator'

/**
 * Implements {@link IdGenerator}, producing UUIDv7.
 *
 * WRAPS: `crypto.getRandomValues` (WebCrypto, available on Workers).
 *
 * WHY HAND-ROLLED: `crypto.randomUUID()` produces v4, which is not sortable.
 * v7 packs a 48-bit big-endian millisecond timestamp into the leading bytes and
 * fills the rest with randomness, so ids sort chronologically as strings and
 * insert near the end of the index rather than scattering across it.
 *
 * Layout (RFC 9562 §5.7):
 *   bytes 0-5   unix_ts_ms, big-endian
 *   byte  6     version (0b0111) in the high nibble, random low nibble
 *   byte  8     variant (0b10) in the two high bits, random remainder
 *   remainder   random
 */
export const uuidV7Generator = (): IdGenerator => ({
  next(): string {
    const bytes = new Uint8Array(16)
    crypto.getRandomValues(bytes)

    const ms = BigInt(Date.now())
    bytes[0] = Number((ms >> 40n) & 0xffn)
    bytes[1] = Number((ms >> 32n) & 0xffn)
    bytes[2] = Number((ms >> 24n) & 0xffn)
    bytes[3] = Number((ms >> 16n) & 0xffn)
    bytes[4] = Number((ms >> 8n) & 0xffn)
    bytes[5] = Number(ms & 0xffn)

    // Version 7 in the high nibble of byte 6, preserving the random low nibble.
    bytes[6] = (bytes[6]! & 0x0f) | 0x70
    // RFC 9562 variant (0b10) in the two high bits of byte 8.
    bytes[8] = (bytes[8]! & 0x3f) | 0x80

    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  },
})

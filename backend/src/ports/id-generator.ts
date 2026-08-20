/**
 * Identifier generation, as a dependency.
 *
 * WHY A PORT: same reason as Clock — `crypto.randomUUID()` in domain code makes
 * assertions impossible and is banned by ESLint inside domain/ and use-cases/
 * (CONVE-13).
 *
 * WHY UUIDv7: ids are time-sortable, so rows cluster by creation order in the
 * index. On SQLite that keeps inserts close to the B-tree hot path instead of
 * scattering them, which UUIDv4 does not. It also makes `ORDER BY id` a
 * meaningful chronological ordering without a separate column.
 *
 * FAILURE MODES: none. Generating an id does not fail.
 */
export interface IdGenerator {
  /** A fresh UUIDv7 in canonical hyphenated form. */
  next(): string
}

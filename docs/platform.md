# Platform adapters

Concrete implementations of the cross-cutting ports in `backend/src/ports/`.
Each wraps one external capability. Replacing any of them is an adapter swap and
one line in `container.ts` — nothing else in the codebase changes.

Module-specific adapters (repositories, better-auth) live inside their module
and are described in [modules.md](./modules.md).

---

| Adapter | Port | Wraps |
|---|---|---|
| `systemClock` | `Clock` | the `Date` global |
| `uuidV7Generator` | `IdGenerator` | WebCrypto RNG |
| `webCryptoRandom` | `Random` | WebCrypto RNG |
| `hmacCodeHasher` | `CodeHasher` | `crypto.subtle` HMAC-SHA256 |
| `kvRateLimiter` | `RateLimiter` | Workers KV |
| `consoleNotifier` | `Notifier` | nothing — writes to stdout |
| `createDatabase` | — | D1 via Drizzle |

---

## `systemClock` → `Clock`

**Why a port:** `Date.now()` inside domain logic makes behaviour untestable —
you cannot assert "this challenge is expired" without sleeping or mutating
globals. ESLint bans `Date` inside `domain/` and `use-cases/` so it cannot be
bypassed.

**Quirk:** Workers freeze `Date.now()` for the duration of a request unless I/O
occurs, as a Spectre mitigation. Two calls in one synchronous block return the
same instant. Fine for expiry; useless for timing code.

**Replacing it:** trivial. Tests already substitute an offset clock to reach
expiry branches.

## `uuidV7Generator` → `IdGenerator`

**Why UUIDv7:** ids are time-sortable, so rows cluster by creation order in the
index instead of scattering as UUIDv4 does. `ORDER BY id` becomes a meaningful
chronological ordering with no extra column.

Hand-rolled because `crypto.randomUUID()` produces v4. Layout follows RFC 9562
§5.7: 48-bit big-endian millisecond timestamp, version nibble, variant bits,
randomness for the remainder.

**Also used by better-auth**, via `advanced.database.generateId`, so every table
in sebp shares one id strategy.

> **Gotcha:** better-auth's `generateId: false` does NOT mean "the caller supplies
> ids" — it means "the database supplies them", which on SQLite with a TEXT
> primary key yields `NOT NULL constraint failed: user.id`. Pass a function.

## `webCryptoRandom` → `Random`

**Failure mode it prevents:** modulo bias. `byte % 10` maps 256 values onto 10
digits unevenly, so 0–5 occur more often than 6–9 — measurably shrinking the OTP
search space. Bytes ≥ 250 are discarded and redrawn instead.

Redraw probability is 6/256, so the loop is not a performance concern.

## `hmacCodeHasher` → `CodeHasher`

**Wraps:** `crypto.subtle`, available on Workers with no compatibility flag.

**Why HMAC rather than a plain hash:** a 6-digit code has 10⁶ possible values, so
a bare SHA-256 is brute-forced from a database leak in milliseconds. The pepper —
a Workers secret, never in the database — is what makes the leak insufficient.

**Why not scrypt:** slow hashes resist offline cracking of user-chosen secrets. An
OTP is server-generated, single-use, attempt-limited, and short-lived; the threat
is disclosure, not grinding. scrypt would cost ~67ms per verification for nothing.

**Constant-time `verify` is a hard requirement.** The submitted code is
attacker-controlled and compared against a secret.

The imported `CryptoKey` is cached per adapter instance — the pepper is fixed for
the isolate's lifetime, so re-importing per call is pure waste.

## `kvRateLimiter` → `RateLimiter`

**Wraps:** a KV namespace. Fixed window; the key embeds the window number, so a
new window uses a new key and the old one expires itself. No cleanup job.

**Quirks that matter:**

1. **KV is eventually consistent.** Reads may be up to ~60s stale and concurrent
   increments can be lost to last-write-wins, so a determined attacker hitting
   many edge locations at once can exceed the nominal limit. Accepted
   deliberately: the goal is stopping casual abuse and runaway loops cheaply.
   Strict counting needs a Durable Object per key.
2. **Minimum TTL is 60 seconds.** A shorter window still stores a 60s entry,
   which only ever over-restricts. Safe direction to fail in.
3. **Failure is not silent.** If KV is unavailable it returns an error rather
   than defaulting to "allowed", and callers refuse the request.

**Replacing it:** a Durable Object or the Cloudflare Rate Limiting binding, if
approximate counting ever stops being good enough.

## `consoleNotifier` → `Notifier`

**Wraps:** nothing. That is the point — local development needs no mail provider,
no API key, and no network.

Not a stub: it is the reason the `Notifier` port exists where it does. OTP
delivery goes through our port rather than better-auth's built-in mailer, so the
transport is swappable. Console today, Pingram later, one line in the composition
root.

Retains recent messages so tests can read the code back out. That is the real
configured adapter being inspected, not a substituted port — which keeps it
inside the rule that substitution is for failure paths only. A dev-only "return
the last OTP" endpoint was deliberately not built; that is a production incident
waiting for one misconfigured variable.

> ⚠️ It **prints live OTP codes to stdout and delivers nothing.** `config.ts`
> refuses to boot with it in production.

## `createDatabase` → Drizzle over D1

**Quirks that matter:**

1. **No interactive transactions.** D1 has no `BEGIN`/`COMMIT` across awaits, so
   `db.transaction()` is unavailable. Multi-statement atomicity uses
   `db.batch()`; read-then-write atomicity uses a conditional `UPDATE` and checks
   `meta.changes`. That is how single-use OTP consumption and optimistic
   concurrency are both enforced.
2. **Narrow types.** No date or boolean. Timestamps are ISO-8601 TEXT (sortable,
   unambiguous), booleans INTEGER 0/1.
3. **No `COMMENT ON`.** Column documentation lives in the Drizzle schema and the
   migration SQL, because SQLite offers nowhere else to put it.

**Replacing it:** Postgres via Hyperdrive is the documented escape hatch
([ADR 0001](./adr/0001-tech-stack.md)). Drizzle's syntax is shared across both,
and repositories return domain entities rather than rows — so the change is
confined to `adapters/`.

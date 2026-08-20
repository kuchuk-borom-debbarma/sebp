# Authentication

How signing up and signing in work in sebp, why they work that way, and what to
be careful of when changing them.

Written for someone who has never seen this codebase. Read
[§12 of the technical design](./technical-design.md#12-authentication-and-authorisation)
for how it fits the wider system.

---

## The short version

**Sign up** is OTP-verified and password-backed. You give an email address, we
send a six-digit code, and you submit that code *together with* a password you
choose. The account is created at that moment — not before.

**Sign in** is email and password. No code.

That asymmetry is deliberate, and it is the first thing to understand.

---

## Why sign-up uses a code but sign-in does not

**Sign-up needs the code** because we must know the address is real and belongs
to whoever is typing. A programme that emails decisions to unverified addresses
sends acceptances into the void.

**Sign-in must NOT need the code**, because delivery is not reliable enough to
put in front of every login. If a code were required each time, an email outage
would lock out every existing user — including programme staff, mid-review, at
exactly the moment they need to be working. Passwords do not depend on a third
party being up.

There is a second consequence: because entering a valid code already proves the
address, there is **no separate "verify your email" step**. Most systems have
both; sebp collapses them into one.

---

## The flow

```
┌── SIGN UP ────────────────────────────────────────────────────────────────┐
│                                                                           │
│  POST /api/v1/auth/request-otp     { email, purpose: "signup" }           │
│        │                                                                  │
│        ├─ rate limit: per address AND per IP                             │
│        ├─ generate a 6-digit code (rejection sampling, not modulo)        │
│        ├─ store HMAC(code, pepper)  ← never the code itself               │
│        ├─ deliver via the Notifier port                                   │
│        └─ 202 Accepted  ← always, even for unknown addresses              │
│                                                                           │
│  POST /api/v1/auth/complete-signup { email, code, password }              │
│        │                                                                  │
│        ├─ check password policy   ← BEFORE consuming the code             │
│        ├─ verify code: constant-time, single-use, expiry, attempt limit   │
│        ├─ create the account (better-auth, scrypt)                        │
│        └─ 201 + session cookie                                            │
└───────────────────────────────────────────────────────────────────────────┘

┌── SIGN IN ────────────────────────────────────────────────────────────────┐
│  POST /api/v1/auth/sign-in         { email, password }                    │
│        └─ 200 + session cookie   |   401 for ANY failure                  │
└───────────────────────────────────────────────────────────────────────────┘

┌── RESET ──────────────────────────────────────────────────────────────────┐
│  request-otp { purpose: "password_reset" }  →  reset-password { code, … } │
│  Same code machinery. Reset is not a weaker way into an account.           │
└───────────────────────────────────────────────────────────────────────────┘
```

---

## Who owns what

This is the part most likely to surprise you.

| | Owns |
|---|---|
| **better-auth** | `user` · `session` · `account` · `verification` tables · password hashing · session issue and validation |
| **us** | `otp_challenges` table · all OTP logic · delivery |

**We deliberately do NOT use better-auth's OTP plugin**, for two reasons.

First, it delivers mail through its own mailer. That would bypass the `Notifier`
port — and the `Notifier` port is precisely what lets a developer run the whole
signup flow locally with no email provider at all, and what will let Pingram drop
in later without touching a single use-case.

Second, its flow assumes verify-then-register as two steps. sebp needs the code
and the password submitted **together**, so that a half-finished signup leaves
nothing behind.

### The confinement rule

better-auth is the single sanctioned exception to sebp's ports-and-adapters
architecture — it owns its own schema and middleware, and wrapping it means
fighting it continuously. The exception is bounded instead:

- ✅ `src/modules/identity/adapters/better-auth/**`
- ✅ `src/http/middleware/auth.ts`
- ❌ **everything else**

Enforced by `dependency-cruiser`, not by review. Every other module sees a
branded `UserId` and nothing more. If better-auth is ever replaced, the blast
radius is one directory plus one file.

---

## Security properties, and why each exists

These are the parts that look like small details and are not.

### Codes are HMAC'd, not hashed

A six-digit code has one million possible values. If we stored `SHA-256(code)`,
anyone with a copy of the database could enumerate all million hashes in well
under a second and read every live code.

Keying the digest with a **pepper** — `OTP_PEPPER`, held in Workers secrets and
never in the database — means a database leak alone is not enough.

We deliberately do **not** use scrypt or argon2 here. Those are slow to resist
offline cracking of *user-chosen* secrets. An OTP is server-generated, single-use,
attempt-limited, and lives ten minutes; the threat is database disclosure, which a
pepper addresses. Slowness would add ~67ms per verification for no gain.

### Comparison is constant-time

`candidate === stored` exits at the first differing character, so the time taken
reveals how many characters matched.

For OTP that leak is genuinely exploitable — the submitted code is
attacker-controlled and compared against a secret, so an attacker could walk the
digest a character at a time. The comparison XOR-accumulates over the whole
string instead.

*(Note: better-auth's own password comparison uses `===`. That is lower severity —
an attacker cannot steer scrypt's output toward a match without inverting scrypt
— but it is worth knowing about.)*

### Code generation avoids modulo bias

The obvious way to turn a random byte into a digit is `byte % 10`. That is biased:
256 is not a multiple of 10, so digits 0–5 occur more often than 6–9. Across six
digits it measurably shrinks the search space.

Bytes ≥ 250 are discarded and redrawn instead (rejection sampling), so every digit
is exactly equally likely.

### The endpoints do not leak who has an account

Several responses are deliberately identical:

| Situation | Response |
|---|---|
| `request-otp` for a known address | 202 |
| `request-otp` for an unknown address | **202** |
| Wrong code | 400 `invalid_code` |
| No challenge exists for that address | **400 `invalid_code`** |
| Wrong password | 401 `invalid_credentials` |
| No such account | **401 `invalid_credentials`** |

Any difference would let anyone discover which founders have applied to the
programme, simply by probing addresses.

Internally the domain *does* distinguish "no challenge" from "wrong code" —
because only one of them should burn an attempt — but that distinction never
reaches the caller.

Two failures **are** reported distinctly, deliberately: `code_expired` (410) and
`too_many_attempts` (429). Both are only reachable by someone who already holds a
real code for that address, so they reveal nothing new — and telling a legitimate
user "your code expired" rather than "wrong code" is the difference between them
requesting a new one and them filing a support ticket.

### Attempt limits cannot be used against a user

Attempts are burned only on a genuine wrong guess — never on an expired or absent
challenge. Otherwise an attacker could lock a founder out simply by spamming
wrong codes at their address.

Expiry is checked *before* the attempt limit for the same reason: a stale
challenge should not consume an attempt and mislead someone into thinking they
mistyped.

`max_attempts` is **snapshotted onto each challenge** when it is issued, not read
live from config. Changing the configured limit must not retroactively lock out —
or silently unlock — a challenge already in flight.

### Single use survives a race

Consumption is a **conditional update** that reports whether it won, not a read
followed by a write. D1 has no interactive transactions, so read-then-write would
let two concurrent submissions of the same valid code both create an account. The
loser is rejected.

### Password policy is checked before the code is consumed

Consuming a single-use code and *then* rejecting the password would burn the code
and force the user to request a new one. Length is checked first.

### Rate limiting covers two dimensions

Per-address **and** per-IP, because they stop different attacks. Per-address alone
does not stop an attacker cycling through thousands of addresses — which is the
case that burns your sending reputation. Per-IP alone does not stop one address
being spammed.

**The limiter fails closed.** If KV is unavailable the request is refused, not
allowed. A broken limiter plus an open OTP endpoint is how you get a five-figure
email bill and a domain flagged as a spam source.

---

## Running it locally

No email provider needed. The `console` notifier prints the message — including
the code — straight to the terminal.

```sh
cd backend
cp .env.example .env.local     # then fill in the two secrets
pnpm dev
```

```sh
curl -X POST localhost:8787/api/v1/auth/request-otp \
  -H 'content-type: application/json' \
  -d '{"email":"founder@example.com","purpose":"signup"}'
```

The wrangler console prints:

```
[notifier:console] email → founder@example.com | Your sebp verification code
Your code is 418302. Use it to finish creating your account. It expires in 10 minutes and can be used once.
```

```sh
curl -X POST localhost:8787/api/v1/auth/complete-signup \
  -H 'content-type: application/json' \
  -d '{"email":"founder@example.com","code":"418302","password":"correct horse battery staple"}'
```

Browse the API at `localhost:8787/docs`.

> ⚠️ The console notifier **prints live codes to stdout and delivers nothing.**
> `config.ts` refuses to boot with `NOTIFIER_DRIVER=console` when
> `ENVIRONMENT=production` — that guard is why it is safe to have at all.

---

## Configuration

Every value comes from the environment, is validated by Zod at boot, and is
frozen. A missing or malformed variable **stops the Worker** rather than
surfacing three days later as a strange bug. `.env.example` documents all of
them; the ones that change behaviour most:

| Variable | Effect |
|---|---|
| `OTP_EXPIRY_SECONDS` | Challenge lifetime. Shorter is safer; too short generates support tickets when mail is slow. |
| `OTP_MAX_ATTEMPTS` | Guesses before lockout. Snapshotted per challenge at issue time. |
| `OTP_PEPPER` | **Secret.** Minimum 32 chars, enforced. Rotating it invalidates every outstanding code. |
| `RATE_LIMIT_OTP_PER_EMAIL` / `_PER_IP` | Abuse limits, per window. |
| `SESSION_COOKIE_DOMAIN` | Must be the **parent** domain in production (`.sebp.com`) so the SSR frontend and API share one session. Empty for localhost. |
| `CORS_ALLOWED_ORIGINS` | Credentials are enabled, so `*` is refused in production. |
| `NOTIFIER_DRIVER` | `console` or `pingram`. `console` is refused in production. |

---

## Testing

Every test issues a **real HTTP request** against **real D1 and KV** inside
workerd. There are no unit tests and no mocked libraries.

Tests read the delivered code out of the console notifier's own retained
messages. That is the *real configured adapter* being inspected, not a
substituted port — which is what keeps it within the rule that port substitution
is for failure paths only.

Substitution is used in exactly three situations, all of them unreachable through
HTTP: a notifier that fails, a rate limiter that fails, and a clock advanced past
expiry (the alternative being a test that genuinely waits ten minutes).

One test file deliberately **skips migrations**, so every database call fails for
real. That covers the repository's error branches with genuine D1 errors rather
than fabricated ones — and it is how we found that a database outage during
sign-in was being reported as "invalid credentials".

---

## What changes when Pingram arrives

Very little, by design.

1. Write `PingramNotifier` implementing the same `Notifier` interface.
2. Add one line in `container.ts` selecting it when `NOTIFIER_DRIVER=pingram`.
3. Set the credential as a Workers secret.

**No use-case, route, domain function, or test changes.** That is the entire
reason OTP delivery was kept out of better-auth.

Phone verification is a similarly small change: the port is already
channel-agnostic (`destination`, not `email`), and `otp_challenges` already has a
`channel` column. It needs a delivery implementation and a way to capture the
number — not a schema migration.

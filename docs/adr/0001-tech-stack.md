# ADR 0001 — Technology stack

**Status:** Accepted · **Date:** 2026-08-20 · **Supersedes:** the provisional stack
notes in [technical-design.md §13](../technical-design.md#13-platform-decisions)

---

## Context

sebp is a startup programme platform whose defining constraint is that stages,
per-stage fields, and document requirements are runtime configuration rather than
code. It needs: dynamic form rendering and validation, secure document upload and
review, email and SMS notification, scheduled reminders and SLA checks, and public
pages that must be indexable.

At the point of this decision no code existed, so every choice below was open.

## Decisions

| Layer | Decision |
|---|---|
| API runtime | **Hono on Cloudflare Workers** — API-only, its own repository |
| Frontend | **TanStack Start on Cloudflare Workers** — SSR, its own repository |
| Frontend → API | **Service Binding** — direct Worker-to-Worker, no network hop |
| Database | **D1**, accessed through ports and adapters |
| Query layer | **Drizzle** |
| Authentication | **better-auth**, running in the API |
| Document storage | **R2** |
| Cache / sessions | **KV** |
| Async work | **Queues** |
| Scheduled work | **Cron Triggers** |
| Email / SMS | **Pingram**, behind an adapter port |
| Validation | **Zod** |
| Tests | **Vitest** with `@cloudflare/vitest-pool-workers` |
| Deployment | **Wrangler** |
| Package manager | **pnpm** |

## Rationale

### Two repositories, not one

The frontend needs server-side rendering for SEO on public programme and event
pages. The API needs none of that. Splitting them keeps each deployable on its own
cadence and stops the API growing view concerns.

The usual cost of this split is a double hop on every SSR render — browser →
frontend server → API. **Service Bindings remove it.** Because both run on Workers,
the frontend calls the API directly with no network round trip, and the API needs
no public exposure to serve SSR traffic. This is the decision that makes the split
nearly free, and it is why the frontend stays on Cloudflare rather than Vercel.

### D1 over Postgres

A single-organisation programme handles thousands of applications, not millions,
with admin-paced writes. D1 is co-located with Workers, needs no connection
pooling, and has no idle cost. Its 10 GB ceiling is comfortable because documents
live in R2 and rows stay small.

The honest counterargument: the dynamic-field model leans on JSON querying, and
Postgres `jsonb` with GIN indexes is genuinely better at arbitrary filtering across
many configured fields than SQLite's `json_extract`. If admin reporting grows into
ad-hoc analytics, that gap will show.

**Ports and adapters is the mitigation.** All persistence sits behind interfaces;
D1 is one adapter. Moving to Postgres via Hyperdrive becomes a new adapter rather
than a rewrite of every handler. Drizzle reinforces this — the same query syntax
targets both.

### TanStack Start over React Router 7 / Next.js

Server functions and type-safe file routing, on Vite, pairing naturally with a REST
API. Next.js was rejected because it wants to own the backend, which fights a
separate Hono API, and its Cloudflare path runs through OpenNext rather than being
native. React Router 7 was the more conservative choice and remains the fallback if
TanStack Start's ecosystem proves too thin.

### better-auth over hand-rolled sessions

Email verification, phone OTP, and session management are enough surface that a
library earns its dependency. It lives in the **API**, not the frontend — auth split
across two servers means two places that can disagree about who a user is. The SSR
frontend forwards the session cookie on server-side fetches.

Both apps deploy under one parent domain (`app.sebp.com`, `api.sebp.com`, cookie
scoped to `.sebp.com`) so SameSite rules do not break the session.

### Everything provider-shaped goes behind a port

Pingram for email and SMS, R2 for storage, KV for cache, Queues for async. Each is
reached through an interface the domain owns. Providers were chosen as "decided for
now, may change" — the adapter layer is what makes that statement true rather than
aspirational.

## Consequences

**Good**

- One platform, one Wrangler workflow, one bill.
- SSR with no internal network latency.
- Database and provider choices stay reversible at adapter cost.
- Public pages are indexable without making the authenticated app render server-side.

**Costs and risks**

- **Two repositories** to version, release, and keep in contract sync. An API change
  can break the frontend with no compile-time link between them. A shared types
  package or generated client is likely needed early.
- **better-auth owns its own schema.** Its `user` / `session` / `account` tables are
  library-shaped, not domain-shaped. This is in direct tension with the ports-and-
  adapters goal, and the `users` table sketched in technical-design.md §4.1 will not
  survive contact with it unchanged. Decide whether the domain reads better-auth's
  tables directly or maps them behind a port.
- **Unverified compatibility.** Three integrations were chosen on reputation and
  must be proven before the build depends on them:
  1. better-auth on Workers with a Drizzle **D1** adapter
  2. TanStack Start deploying to Workers **with Service Bindings** reachable from
     server functions
  3. Pingram's actual API — auth model, delivery webhooks, OTP support, SMS regional
     coverage
- **No bcrypt in Workers.** If any password hashing is handled outside better-auth,
  it must use WebCrypto PBKDF2 or a WASM argon2 build.
- **TanStack Start is younger** than the alternatives. Fewer worked examples when
  something breaks.

## Follow-up

A spike proving points 1–3 above should precede Phase 1 of the build sequence. All
three are load-bearing, and discovering a blocker after the foundation is built is
significantly more expensive than a day of verification now.

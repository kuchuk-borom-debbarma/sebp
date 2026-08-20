# Modules

The API is organised **module-first**: one directory per subsystem, each
internally hexagonal. See [ADR 0002](./adr/0002-codebase-structure.md) for why,
and [codebase-structure.md](./codebase-structure.md) for the rules.

The deciding factor was parallel work. Layer-first (`domain/`, `adapters/`,
`http/` at the top) means every feature spans four directories, so two agents
building different subsystems collide constantly. Module-first gives each one a
directory to own.

---

## The shape, every time

```
modules/<name>/
├── index.ts        PUBLIC SURFACE — the only importable file
├── domain/         pure. no framework, no I/O, no clock, no crypto
├── ports/          interfaces THIS module owns
├── use-cases/      orchestration: domain + ports
├── adapters/       PRIVATE. implementations
└── http/           PRIVATE. routes and Zod schemas
```

**From outside a module the only legal import path is `@/modules/<name>`.** Deep
paths are a `dependency-cruiser` error, not a review comment. A module's
`index.ts` exports exactly three kinds of thing: domain types other modules may
reference, port interfaces they may depend on, and a factory the composition root
calls. Never adapters, never routes.

When one module needs another's behaviour, it depends on the other's **port** and
the container injects the implementation. If two modules need each other's
internals, the boundary is in the wrong place — move the code rather than
widening the surface.

---

## `identity` — built

Accounts, credentials, sessions, and the one-time-code machinery.

| | |
|---|---|
| **Owns** | `otp_challenges` table, OTP issue/verify/consume logic, delivery |
| **Public surface** | `UserId`, `OtpPurpose`, `OtpFailure`, `IdentityError`, `OtpChallengeRepo`, `createIdentityModule` |
| **Ports it owns** | `OtpChallengeRepo` |
| **Ports it consumes** | `Clock`, `IdGenerator`, `Random`, `CodeHasher`, `Notifier`, `RateLimiter` |
| **Exception** | contains better-auth, confined to `adapters/better-auth/` |

**Why the boundary sits here:** authentication is the one thing every other
module depends on and none of them should understand. Everything downstream
receives a branded `UserId` and never learns which library issued it.

Full detail in [authentication.md](./authentication.md).

> **This module is atypical.** It is the sanctioned exception to strict layering,
> so it demonstrates *fewer* of the conventions than a normal module does. Use
> `rounds` (next) as the pattern reference, not this.

---

## Planned

Not built. Listed so the intended boundaries are visible before anyone draws them
differently. Schema is progressive — each module's tables arrive with the module.

### `stage-config`
The spine of the product. Admin-defined rounds, stages, per-stage fields and
document requirements, all locale-keyed. Compiles a cached configuration snapshot
that freezes when a round opens.
*Owns:* `rounds`, `stage_definitions`, `field_definitions`, `document_requirements`,
`stage_transitions_config`. *Consumes:* `KeyValueStore` for the snapshot cache.

### `application`
Applications scoped to a round: stage instances, the `outstanding()` engine that
decides what a startup still owes, and transition execution with gate evaluation.
*Owns:* `applications`, `application_stage_instances`, `stage_transition_log`.
*Consumes:* `stage-config` queries.

### `document`
Presigned direct-to-R2 upload, versioned re-uploads, approve/reject/request-redo,
expiry, and the duplicate-approval gate — configurable identifier fields,
normalised before comparison, blocking approval on a match with an audited
override.
*Owns:* `document_submissions`, `document_identities`.
*Consumes:* `ObjectStorage`, `JobQueue`, a `MalwareScanner` port not yet written.

### `notification`
In-app inbox plus external delivery. Admin-editable templates and triggers, queue
fan-out, delivery webhooks.
*Owns:* `notification_templates`, `notification_triggers`, `notifications`,
`notification_deliveries`. *Consumes:* `Notifier`, `JobQueue`.

The `Notifier` port already exists and is implemented by `consoleNotifier` — this
module will be its main consumer once it lands.

### `event`
Programme sessions with registration, capacity, waitlist and reminders. Central
rather than peripheral, because the platform runs the programme after acceptance.
*Owns:* `events`, `event_registrations`.

### `announcement`
Targeted, schedulable posts with read tracking.
*Owns:* `announcements`, `announcement_reads`.

> `event`, `announcement` and `notification` share one audience-resolution shape
> (`{"type":"all"}`, `{"type":"stage","stage_id":…}`). Write
> `resolveAudience(spec) → UserId[]` **once** and share it — three
> near-identical implementations is the predictable failure here.

### `support`
Ticketed help desk, threaded replies, staff-only internal notes, first-response
tracking.
*Owns:* `support_tickets`, `support_messages`.

### `audit`
Every configuration change and decision, recorded.
*Owns:* `audit_log`.

> **Constraint, not a preference:** `audit_log` holds **no personal data** —
> `user_id` references only, never names, emails, or document contents. The log
> is append-only while data-protection obligations may require erasing a person's
> details. Keeping PII out is what lets both hold at once.

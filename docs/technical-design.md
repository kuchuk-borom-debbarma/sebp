# sebp — Technical Design Document

**Status:** Draft · **Audience:** Engineering · **Last updated:** 2026-08-20

---

## 1. What we are building

sebp is the platform on which a startup programme runs. Startups sign up, complete
an application, upload required documents, and are advanced by the programme team
through a series of stages. Around that core sit five supporting subsystems:
in-app notifications, external notifications (email/SMS), announcements, calendar
events, and a support desk.

The website **is** the programme — there is no separate marketing site handing off
to an internal tool. Applicants, programme staff, and the programme's public face
all live in one system.

### 1.1 The defining constraint

> **Nothing about the programme's shape is hardcoded.**

Stages, the data captured at each stage, and the documents each stage requires are
all defined as rows in the database and edited by admins at runtime. No deploy is
required to add a stage, change a required document, or add a question to a form.

This is not a nice-to-have. It is the product. Every design decision below is
downstream of it, and the most common way this project can fail is an engineer
writing:

```ts
const STAGES = ['applied', 'screening', 'interview', 'accepted']  // ← forbidden
```

If you find yourself typing a stage name, a field name, or a document name into
source code, stop. It belongs in configuration.

### 1.2 Tenancy

**Single organisation.** One programme team, one set of stage configurations, one
applicant pool. There is no tenant scoping on tables and no per-tenant branding.

We deliberately do not build for multi-tenancy, but §15.2 records the seams where
it would be introduced if that changes.

---

## 2. Actors

| Actor | Description |
|---|---|
| **Applicant (founder)** | A person who signs up and applies. One founder, one startup. |
| **Startup** | The applying entity, owned by exactly one founder. One application per round. |
| **Reviewer** | Programme staff who evaluate applications and approve documents. |
| **Admin** | Programme staff who configure stages, fields, documents, templates, events. |
| **Support agent** | Handles support tickets. Often the same humans as reviewers. |
| **System** | Scheduled jobs — SLA checks, reminders, document expiry, scheduled publishes. |

Roles are data (§12), not enum constants. "Reviewer" and "Admin" are seeded rows,
and permissions are granted per role.

---

## 3. Architecture overview

**Runtime:** Hono on Cloudflare Workers, API-only, in its own repository. The
frontend is a separate TanStack Start app, also on Workers, reaching the API through
a **Service Binding** — a direct Worker-to-Worker call with no network hop, so the
API needs no public exposure to serve SSR traffic.

Settled in [ADR 0001](./adr/0001-tech-stack.md). Providers remain replaceable behind
ports — see §13.6.

```
   Browser ──▶ ┌─────────────────────────┐   Service   ┌──────────────────┐
               │ TanStack Start (Worker) │  Binding    │  Hono API Worker │
               │   SSR, public + app     │────────────▶│                  │
               └─────────────────────────┘             └────────┬─────────┘
                                                                │
        ┌────────────────┬───────────────┼────────────────┬───────────────┐
        ▼                ▼               ▼                ▼               ▼
   ┌─────────┐    ┌────────────┐   ┌──────────┐    ┌────────────┐  ┌───────────┐
   │   D1    │    │     R2     │   │    KV    │    │   Queues   │  │   Cron    │
   │ (rows)  │    │(documents) │   │ (config  │    │(notify fan-│  │(SLA, rem- │
   │         │    │            │   │  cache,  │    │ out, doc   │  │ inders,   │
   │         │    │            │   │ sessions)│    │ post-proc) │  │ expiry)   │
   └─────────┘    └────────────┘   └──────────┘    └─────┬──────┘  └───────────┘
                                                          │
                                                          ▼
                                                  ┌───────────────┐
                                                  │ Notification  │
                                                  │   provider    │
                                                  │  (Pingram)    │
                                                  └───────────────┘
```

### 3.1 Why this shape

- **Documents are the heavy payload.** R2 has no egress fees and is S3-compatible,
  which matters when reviewers repeatedly download applicant PDFs.
- **Config is read-hot, write-cold.** Stage/field/document definitions are read on
  virtually every request and edited a few times a month. That is a cache-shaped
  workload (§5.4).
- **Notification fan-out must not block a stage transition.** Advancing an
  application should commit and return; emails and SMS go through a queue with
  retries.
- **Programme work is deadline-driven.** SLA breaches, event reminders, and
  document expiry all need scheduled execution — Cron Triggers rather than a
  long-running scheduler, since Workers have no persistent processes.

---

## 4. Data model

Conventions used below: `id` is a UUIDv7 (time-sortable) unless noted. All tables
carry `created_at` / `updated_at`. Soft deletion uses `archived_at` — **configuration
rows are never hard-deleted** (§5.5 explains why).

### 4.1 Identity

```
users
  id, email UNIQUE, phone, name,
  password_hash, email_verified_at, phone_verified_at,
  status (invited | active | suspended),
  last_login_at, created_at, updated_at

startups
  id, owner_user_id UNIQUE,      -- exactly one founder per startup
  name, slug UNIQUE, website,
  status (draft | active | withdrawn),
  created_at, updated_at
  -- all other startup profile data lives in field_values (§4.3)
```

**One founder, one startup, one application per round.** There is no team
membership, no invite flow, and no intra-startup roles. Every ownership check
reduces to comparing `startups.owner_user_id` against the caller.

`users` and `sessions` above are **owned by better-auth**, not by us — the shapes
shown are indicative. See §12 for the boundary.

Note that `startups` has almost no columns. Everything a programme wants to know
about a startup — sector, stage of company, revenue, team size — is admin-configured
and therefore lives in `field_values`. Only fields the *system itself* needs to
function (name, slug) are real columns.

### 4.2 Rounds

A **round** is one intake of the programme. It is the scoping dimension for
applications, stage configuration, events, and announcements.

```
rounds
  id, key UNIQUE, name, description,
  applications_open_at  NULL,    -- NULL = always open
  applications_close_at NULL,    -- NULL = never closes
  starts_at NULL, ends_at NULL,  -- the programme period itself
  status (draft | open | closed | running | completed | archived),
  cloned_from_round_id NULL,
  created_at, updated_at
```

**One model, both modes.** A batched programme creates several rounds with real
open/close dates — *Spring 2027*, *Autumn 2027* — each selecting a group that goes
through the programme together. A continuous programme runs a single perpetual
round with `applications_close_at = NULL` that never completes. Both can coexist:
an always-open intake track and a batched accelerator are simply two rounds.

Nothing needs to know which mode is in use. The scoping is unconditional; only the
dates differ.

**Configuration belongs to a round.** Stage definitions, field definitions, and
document requirements are all scoped by `round_id`, and a round's configuration
freezes when it opens. This is what removes the version-pinning machinery that
would otherwise be required — see §5.5.

**Cloning is required, not optional.** Creating *Autumn 2027* must be able to copy
*Spring 2027*'s entire configuration (`cloned_from_round_id` records the lineage).
Without it, admins rebuild fifteen stages by hand every intake, and they will
instead keep reusing one round and defeat the design.

### 4.3 Stage configuration

```
stage_definitions
  id, round_id,
  key, name JSON, description JSON,   -- name/description locale-keyed
  order_index,
  kind (form | review | action_required | terminal),
  applicant_visible BOOL,        -- can applicants see this stage exists?
  sla_days INT NULL,             -- expected time to decide
  is_entry BOOL,                 -- the stage new applications start in
  archived_at NULL
  UNIQUE (round_id, key) WHERE archived_at IS NULL

stage_transitions_config
  id, from_stage_id, to_stage_id,
  label,                          -- "Advance to interview", "Reject"
  outcome (advance | reject | withdraw | return),
  requires_all_required_fields BOOL,
  requires_all_documents_approved BOOL,
  required_permission,            -- e.g. 'application.decide'
  auto_when JSON NULL,            -- optional auto-advance condition
  order_index
```

A transition is only legal if a `stage_transitions_config` row exists for the
`(from, to)` pair. This makes the workflow a **configured directed graph**, not a
linear list — which is what makes rejection, withdrawal, and send-back-for-changes
work without special cases.

### 4.4 Dynamic fields

```
field_definitions
  id, round_id,
  stage_id NULL,                  -- NULL = startup profile field, not stage-bound
  key,
  label JSON,                     -- locale-keyed: {"en": "...", "fr": "..."}
  help_text JSON,                 -- locale-keyed
  data_type (text | longtext | number | date | select | multiselect
             | boolean | url | email | phone | money | file),
  options JSON NULL,              -- for select / multiselect
  validation JSON NULL,           -- { required, min, max, maxLength, pattern }
  applicant_editable BOOL,
  admin_only BOOL,                -- reviewer-only scoring/notes fields
  order_index,
  archived_at NULL
  UNIQUE (stage_id, key) WHERE archived_at IS NULL

field_values
  id, application_id,
  field_definition_id,
  value JSON,                     -- always JSON-encoded, typed on read
  updated_by, updated_at
  UNIQUE (application_id, field_definition_id)
```

**On storing values as JSON:** the alternative — a column per data type
(`value_text`, `value_number`, …) — buys typed indexes at the cost of a wider
table and branching on every read and write. We store a single JSON value and add
generated columns with indexes for the specific fields admins actually filter and
sort on (§13.3). Start simple; add indexes when a real query is slow.

### 4.5 Document requirements

```
document_requirements
  id, round_id,
  stage_id NULL,                  -- NULL = required regardless of stage
  key,
  name JSON, description JSON,    -- locale-keyed
  required BOOL,
  accepted_mime_types JSON,       -- ["application/pdf", "image/png"]
  max_size_bytes, max_files,
  expires_after_days INT NULL,    -- e.g. certificate valid 12 months
  identity_fields JSON,           -- see §7.5 — [{key,label,unique_scope}]
  order_index,
  archived_at NULL

document_submissions
  id, application_id, stage_instance_id NULL,
  requirement_id,
  r2_key, filename, mime_type, size_bytes, checksum_sha256,
  version INT,                    -- re-uploads increment, never overwrite
  status (uploaded | scanning | under_review | approved | rejected | expired),
  review_note, reviewed_by, reviewed_at,
  uploaded_by, uploaded_at, expires_at
```

Re-uploads create a **new version row** rather than replacing the old one. A
rejected document and the corrected replacement are both part of the record — that
history is exactly what an admin needs when a decision is questioned later.

### 4.6 Application runtime

```
applications
  id, startup_id, round_id,
  current_stage_id,
  status (draft | active | withdrawn | rejected | accepted | completed),
  submitted_at, created_at, updated_at
  UNIQUE (startup_id, round_id)   -- one application per startup per round

application_stage_instances
  id, application_id, stage_id,
  status (pending | in_progress | submitted | under_review
          | changes_requested | approved | rejected | skipped),
  -- reviewers act with: approve | reject | request_redo (§7.5)
  entered_at, submitted_at,
  decided_at, decided_by, decision_note,
  sla_due_at
  -- one row per entry into a stage; re-entry creates a new row

stage_transition_log
  id, application_id,
  from_stage_id NULL, to_stage_id,
  transition_config_id NULL,
  actor_id, actor_type (applicant | admin | system),
  reason, created_at
```

`application_stage_instances` is the join between configuration and reality. A stage
*definition* says "Interview requires a pitch deck and a scheduled slot"; a stage
*instance* says "this startup entered Interview on 3 March, is under review, and is
two days past SLA."

### 4.7 Notifications

```
notification_templates
  id, key UNIQUE, name,
  subject_template JSON,             -- locale-keyed, §8.2
  body_template JSON,                -- locale-keyed
  sms_template JSON NULL,            -- locale-keyed
  archived_at NULL

notification_triggers
  id, event_key,                     -- 'stage.entered', 'document.rejected', …
  template_id,
  channels JSON,                     -- ["in_app", "email", "sms"]
  audience JSON,                     -- {"type":"applicant"} | {"type":"role","role":"reviewer"}
  conditions JSON NULL,              -- e.g. only for stage X
  delay_seconds INT DEFAULT 0,
  enabled BOOL

notifications                        -- the in-app inbox
  id, user_id, type, title, body, link_url,
  read_at NULL, created_at

notification_deliveries              -- external send log
  id, notification_id, channel (email | sms),
  provider, provider_message_id,
  status (queued | sent | delivered | bounced | failed),
  error, attempts, sent_at
```

Which events send which notifications on which channels to whom is **configuration**,
consistent with §1.1. Adding "text the applicant when their document is rejected"
is a row, not a deploy.

### 4.8 Events, announcements, support

```
events
  id, round_id NULL,                 -- NULL = programme-wide, not round-specific
  title, description,
  starts_at, ends_at, timezone,
  location_type (online | in_person | hybrid), location, meeting_url,
  capacity INT NULL, registration_required BOOL,
  registration_opens_at, registration_closes_at,
  visibility JSON,                   -- {"type":"all"} | {"type":"stage","stage_id":…}
  status (draft | published | cancelled),
  created_by, created_at

event_registrations
  id, event_id, user_id,
  status (registered | waitlisted | cancelled | attended | no_show),
  registered_at
  UNIQUE (event_id, user_id)

announcements
  id, round_id NULL,                 -- NULL = programme-wide
  title, body,
  audience JSON,                     -- same shape as event visibility
  pinned BOOL,
  publish_at, expires_at NULL,
  status (draft | scheduled | published | archived),
  created_by, created_at

announcement_reads
  id, announcement_id, user_id, read_at
  UNIQUE (announcement_id, user_id)

support_tickets
  id, user_id, application_id NULL,
  subject, category, priority (low | normal | high),
  status (open | pending | resolved | closed),
  assigned_to NULL,
  first_response_at, resolved_at, created_at, updated_at

support_messages
  id, ticket_id, author_id, author_type (applicant | admin),
  body, internal_note BOOL,          -- internal notes hidden from applicant
  created_at
```

`events.visibility`, `announcements.audience`, and `notification_triggers.audience`
deliberately share one JSON audience shape. Write the resolver once
(`resolveAudience(spec) → user_id[]`) and reuse it in all three.

### 4.9 Audit

```
audit_log
  id, actor_id, actor_type, action,
  entity_type, entity_id,
  before JSON NULL, after JSON NULL,
  ip, user_agent, created_at
```

Every configuration change and every application decision is written here. In a
programme where people are accepted and rejected, "who changed the required
documents, and when" is a question that *will* be asked.

⚠️ **No personal data in `audit_log`.** Reference `user_id`, never names, emails, or
document contents. The log is append-only while data-protection obligations may
require erasing a person's details; keeping PII out is what lets both hold at once —
the user record can be scrubbed while the trail survives intact.

---

## 5. The stage engine

### 5.1 Responsibilities

1. Given an application, report its current stage, what is outstanding, and which
   transitions are legal for the current actor.
2. Validate and execute a transition atomically.
3. Emit domain events so notifications, SLA timers, and the audit log follow.

### 5.2 Computing "what is outstanding"

```
outstanding(application) =
    required field_definitions for current stage, minus those with a field_value
  + required document_requirements for current stage, minus those with an
    approved document_submission
```

This single function drives the applicant's checklist UI, the reviewer's readiness
badge, and the `requires_*` gates on transitions. Implement it once, server-side.
Do not reimplement it in the frontend — the client may *display* the result, but
must never be the authority on it.

### 5.3 Executing a transition

```
POST /api/v1/applications/:id/transition
  { "to_stage_id": "...", "transition_config_id": "...", "reason": "..." }
```

1. Load application and lock it (§5.6).
2. Find the `stage_transitions_config` row for `(current_stage, to_stage)`.
   Absent → **409 Conflict**, not 400. The request was well-formed; the state was wrong.
3. Check the actor holds `required_permission`.
4. Evaluate `requires_all_required_fields` / `requires_all_documents_approved`
   against §5.2. Failure → 422 with the specific list of what is missing.
5. In one transaction: close the current `stage_instance`, create the next one,
   update `applications.current_stage_id`, write `stage_transition_log` and `audit_log`.
6. After commit, enqueue `stage.entered` (and `stage.exited`) onto the notification queue.

Step 6 is deliberately outside the transaction. A failed email must never roll back
an accepted applicant.

### 5.4 Config caching

Stage/field/document definitions are read constantly and written rarely. Compile
them into a single immutable snapshot:

```ts
type ConfigSnapshot = {
  version: number
  stages: Stage[]
  transitions: TransitionRule[]
  fieldsByStage: Record<string, FieldDef[]>
  docsByStage: Record<string, DocRequirement[]>
}
```

Store in KV under `config:v{n}`, with `config:current` holding the active version
number. Any admin write bumps the version and writes a new snapshot. Workers read
`config:current` once per request (or cache in module scope for the isolate's
lifetime) and fetch the snapshot. Because snapshots are immutable and versioned,
cache invalidation reduces to reading one integer.

### 5.5 Configuration changes mid-flight

An admin edits stage configuration while forty applications are in progress. What
happens to them?

**Rounds answer most of this.** Configuration is scoped to a round (§4.2), and a
round's configuration **freezes when the round opens**. Applications belong to a
round, so they are evaluated against a configuration that cannot shift underneath
them. Next intake's changes go into the next round, cloned from this one and edited
freely while still in `draft`.

That leaves a narrow case: an admin genuinely needs to change an **open** round —
a required document turns out to be unobtainable, or a question was worded wrongly.

**Rules for editing an open round:**

1. **Configuration rows are never hard-deleted**, only `archived_at`. An archived
   field still renders its historical value on applications that captured it.
2. **Widening changes apply immediately.** Adding an optional field, adding a
   non-required document, relaxing a requirement, fixing a label or translation.
   These cannot invalidate completed work.
3. **Narrowing changes require explicit confirmation.** Adding a required item,
   removing a stage, or reordering stages. The admin is shown exactly how many
   in-flight applications become newly incomplete, and the change is audited.
4. **A closed or running round's configuration is immutable** except for labels and
   translations.

Getting this wrong produces the worst bug class this system can have: an applicant
who completed everything is silently marked incomplete, or is advanced past a
document that has since become mandatory. Round-scoped configuration removes most
of that risk structurally rather than procedurally — which is why the round
dimension is worth its cost.

### 5.6 Concurrency

Two reviewers clicking "Advance" simultaneously must not produce two stage
instances. Options, in order of preference:

1. **Conditional update** — `UPDATE applications SET current_stage_id = ? WHERE
   id = ? AND current_stage_id = ?`, and treat zero affected rows as a lost race
   (409). Cheap, portable, sufficient.
2. **Durable Object per application** as a serialisation point, if transitions grow
   more complex than a single-row update.

Start with (1).

---

## 6. Dynamic forms

### 6.1 Server-side validation is compiled from configuration

```ts
function buildValidator(fields: FieldDef[]): ZodSchema {
  return z.object(Object.fromEntries(
    fields.map(f => [f.key, applyRules(baseTypeFor(f.data_type), f.validation)])
  ))
}
```

The schema is derived from the same rows that render the form. There is no second
place where "phone must match this pattern" is written, so the two cannot drift.

### 6.2 Rendering

The frontend fetches the field definitions for a stage and renders a component per
`data_type`. Adding a data type means adding one renderer and one validator branch
— the only two places a `switch` on field type is acceptable.

### 6.3 Conditional fields

`validation.visible_when` (e.g. `{"field":"has_revenue","equals":true}`) hides
fields client-side **and** is honoured server-side: a hidden field is not required.
Evaluate the same condition in both places from the same stored rule.

---

## 7. Documents

### 7.1 Upload path

Do **not** stream uploads through the Worker. Issue a short-lived R2 presigned
`PUT`, let the browser upload directly, then have the client confirm:

```
POST /api/v1/documents/presign     → { url, r2_key, expires_at }
PUT  <presigned url>               (browser → R2, direct)
POST /api/v1/documents/confirm     → creates document_submissions row
```

This keeps large files off Worker CPU and request-size limits, and it means an
abandoned upload leaves an orphaned R2 object rather than a corrupt database row.
A weekly cron sweeps R2 keys with no confirming row.

Validate `mime_type` and `size_bytes` against the requirement **at presign time**
(reject early) **and** at confirm time (the client is not trusted).

### 7.2 Download path

Never expose R2 URLs directly. `GET /api/v1/documents/:id/download` authorises the
caller, then issues a short-lived presigned GET (≤ 60s) and redirects. Every
download is written to `audit_log` — applicant documents are sensitive and "who
looked at this" is an answerable question.

### 7.3 Malware scanning

**Open item.** Cloudflare provides no native object scanning. Uploads land in
`status = scanning` and are not visible to reviewers until cleared. The scanner
itself must be chosen: a third-party API called from a queue consumer, or a
container running ClamAV outside Workers. Do not skip this — the platform invites
strangers to upload files that staff will open.

### 7.4 Review decisions

A reviewer acting on a stage or a document has exactly three outcomes:

| Outcome | Meaning |
|---|---|
| **Approve** | Accepted. Subject to the duplicate gate below. |
| **Reject** | Not accepted. Reason required. |
| **Request redo** | Returned to the applicant for correction. Reason required, and it names what must change. |

Reason text is mandatory on reject and request-redo, and surfaced verbatim to the
applicant — a rejection an applicant cannot act on generates a support ticket.

### 7.5 Document identity and the duplicate gate

**The problem.** One real company creates two applications — a second account, a
slightly different name, a fresh email — and both get approved by different
reviewers who never see each other's work. Nothing in the flow described so far
catches it.

**The mechanism.** Approval is a guarded action. Document requirements declare
which identifiers their document carries, and the reviewer records those
identifiers at the moment of approval. The system then checks them against every
already-approved record and refuses the approval on a match.

Identifier definitions are configuration, consistent with §1.1:

```
-- document_requirements.identity_fields, e.g.
[ { "key": "company_reg_no", "label": {"en": "Registration number"},
    "unique_scope": "global" },
  { "key": "tax_id",         "label": {"en": "Tax ID"},
    "unique_scope": "round"  } ]
```

```
document_identities
  id, document_submission_id, application_id,
  requirement_id, field_key,
  value_normalised,               -- trimmed, uppercased, punctuation stripped
  value_raw,
  round_id,
  recorded_by, recorded_at
  UNIQUE (field_key, value_normalised) WHERE unique_scope = 'global'
  UNIQUE (field_key, value_normalised, round_id) WHERE unique_scope = 'round'
```

**Normalise before comparing.** `U-1234/AB`, `u1234ab`, and `U 1234 AB` are the
same registration number to a human and three different strings to a database. The
normalised value is what carries the constraint; the raw value is kept for display.

**On a match, approval is blocked and the reviewer is shown the conflicting
record** — which application, which round, its current status.

**Override is possible but expensive.** A privileged admin may force the approval
with a written justification. The override is written to `audit_log` with both
application references and appears on the report of forced approvals. Legitimate
collisions exist — a genuine re-application after rejection, a shared registration
number across group companies — so a hard block with no escape hatch would push
staff into manual database edits, which is strictly worse.

**Uniqueness scope is per identifier.** A company registration number is probably
unique programme-wide (`global`). A founder's ID document might reasonably recur
across rounds if re-applying is allowed (`round`).

### 7.6 Expiry

Requirements with `expires_after_days` set `document_submissions.expires_at` on
approval. A daily cron flips lapsed rows to `expired` and fires
`document.expired`, which reopens the requirement in the applicant's checklist.

---

### 7.7 Retention and archival

Documents and application records stay live for **one year** after a terminal
decision, then move to cold storage — R2 Infrequent Access — where they remain
retrievable, just slower and cheaper. Database rows are not deleted; only the object
storage class changes.

A monthly cron identifies eligible records and transitions them. Retrieval from
cold storage is transparent to the reviewer, so no separate flow is needed.

Retention interacts with §4.9's rule that `audit_log` holds no personal data: the
audit trail survives archival and any future erasure request untouched, because it
never contained anything that needs erasing.

---

## 8. Notifications

### 8.1 Pipeline

```
domain event ──▶ resolve triggers ──▶ resolve audience ──▶ per user/channel:
                                                            in_app  → notifications row
                                                            email   → Queue → provider
                                                            sms     → Queue → provider
```

In-app notifications are written synchronously (cheap, same database). External
sends go to a Queue with retry and dead-lettering, so provider downtime delays
delivery instead of failing the originating action.

### 8.2 Templates

Templates interpolate a whitelisted context — `{{startup.name}}`,
`{{stage.name}}`, `{{application.url}}`. Use a logic-less renderer over a general
template language: these are edited by admins in a browser, and a template engine
with arbitrary expressions is a code-execution surface handed to the marketing team.

### 8.3 Provider adapter

```ts
interface NotificationProvider {
  sendEmail(to: string, subject: string, body: string): Promise<ProviderResult>
  sendSms(to: string, body: string): Promise<ProviderResult>
}
```

**Pingram** is the chosen provider for email and phone. The specifics of its API —
authentication, delivery webhooks, OTP support, regional SMS coverage — must be
confirmed against its documentation before implementation; they are not assumed
here. The adapter interface above is what the rest of the system depends on, so a
provider change is one file plus a config value.

Delivery webhooks (bounces, failures) update `notification_deliveries.status`.
Hard bounces should surface in admin UI — an applicant silently not receiving
decision emails is a serious failure mode in a programme with deadlines.

### 8.4 Preferences and safety

- Per-user channel preferences, with a non-optional class for decisions and
  deadlines (an applicant must not be able to mute a rejection).
- Rate-limit per user per hour; a config mistake must not send 400 texts.
- **A staging environment must never send to real applicants.** Gate on an
  environment flag with an allowlist. This is the single most common way a
  platform like this embarrasses itself.

---

## 9. Events, announcements, support

**Events** — admin creates, publishes, and optionally requires registration with
capacity and a waitlist. Cron fires reminders (24h, 1h) via §8. Attendance is
recorded for programme reporting. Serve an `.ics` feed; founders live in their
calendars.

**Announcements** — targeted by the shared audience resolver, optionally pinned and
scheduled. `announcement_reads` supports "3 unread" badges and lets admins see
reach.

**Support** — ticket plus threaded messages, `internal_note` for staff-only
comments. Attachments reuse the §7 pipeline. Track `first_response_at` for
responsiveness reporting. Inbound email-to-ticket is explicitly out of scope for v1.

---

## 10. Localisation

Multi-language support is required from day one; **English is the default and the
only language at launch**, with others added later without schema change.

**Configuration carries its own translations.** Every admin-editable label —
`stage_definitions.name`, `field_definitions.label` and `help_text`,
`document_requirements.name` and `description`, notification templates — is stored
as a locale-keyed JSON object rather than a string:

```json
{ "en": "Registration number", "fr": "Numéro d'immatriculation" }
```

Resolution falls back to `en` for any missing locale, so adding a language never
breaks a screen — it degrades to English until translated.

**UI strings** in `sebp-web` use a conventional i18n catalogue; they are code, not
configuration.

**Locale is resolved per request** from the user's profile preference, falling back
to `Accept-Language`, falling back to `en`. Notifications render in the recipient's
preferred locale, not the sender's.

This is cheap now and expensive later: retrofitting translation into configuration
rows means migrating every definition and every template, plus a locale-aware admin
editor. Storing the JSON shape from the first migration costs almost nothing even
while only `en` is populated.

---

## 11. API design

REST, versioned at `/api/v1`, Hono routers per resource, Zod at every boundary.

```
POST   /api/v1/auth/signup | login | logout | verify-email | verify-phone
GET    /api/v1/me

GET    /api/v1/applications/:id                 -- includes stage, outstanding items
PATCH  /api/v1/applications/:id/fields
POST   /api/v1/applications/:id/submit
POST   /api/v1/applications/:id/transition      -- §5.3
GET    /api/v1/applications                     -- admin list: filter, sort, paginate

POST   /api/v1/documents/presign | confirm
GET    /api/v1/documents/:id/download
POST   /api/v1/documents/:id/review             -- approve | reject + note

GET    /api/v1/config/stages                    -- compiled snapshot for rendering
CRUD   /api/v1/admin/stages | fields | documents | transitions | templates | triggers

CRUD   /api/v1/events        + POST /:id/register
CRUD   /api/v1/announcements
CRUD   /api/v1/support/tickets + POST /:id/messages
GET    /api/v1/notifications + POST /:id/read
```

**Conventions:** cursor pagination (`?cursor=&limit=`); `409` for state conflicts,
`422` with a per-field error map for validation; every mutation accepts an
`Idempotency-Key` — flaky mobile connections retrying a stage transition must not
double-advance an applicant.

---

## 12. Authentication and authorisation

**Authentication** — **better-auth**, running in the API rather than the frontend:
auth split across two servers means two places that can disagree about who a user
is. It covers email + password, email verification, phone OTP, and session
management. Sessions stay server-side rather than JWT — staff need immediate
revocation. Turnstile on signup.

The SSR frontend forwards the session cookie on its server-side fetches. Both apps
deploy under one parent domain (`app.sebp.com`, `api.sebp.com`, cookie scoped to
`.sebp.com`) or SameSite rules break the session.

⚠️ **better-auth owns its own schema.** Its `user` / `session` / `account` tables are
library-shaped, and the `users` table sketched in §4.1 will not survive contact with
it unchanged. Decide early whether the domain reads those tables directly or maps
them behind a port. Note also that bcrypt is unavailable in Workers — any hashing
outside better-auth must use WebCrypto PBKDF2 or a WASM argon2 build.

**Authorisation** — role-based, roles as data:

```
roles (id, key, name)
permissions (id, key)                 -- 'application.view', 'application.decide',
                                      -- 'config.edit', 'support.respond', …
role_permissions (role_id, permission_id)
user_roles (user_id, role_id)
```

Enforce with Hono middleware at the router level, plus a row-level check that an
applicant may only reach their own startup's application. Applicant scoping must
be a shared helper, not repeated per handler — that is where these systems leak.

---

## 13. Platform decisions

### 13.1 D1 vs Postgres

**Decided: D1, behind ports and adapters** ([ADR 0001](./adr/0001-tech-stack.md)).

D1 is SQLite: it is co-located with Workers, requires no connection pooling, has no
idle cost, and comfortably handles a programme's volume (thousands of applications,
not millions). SQLite's JSON1 functions plus generated columns cover the dynamic-field
queries described in §13.3.

Constraints to respect: a 10 GB database limit (documents live in R2, so rows stay
small), no long-lived transactions, and modest write concurrency — all acceptable
for admin-paced workloads.

**If** reporting needs grow into complex ad-hoc analytics over dynamic fields,
Postgres via Hyperdrive with `jsonb` and GIN indexes is the escape hatch. All
persistence sits behind domain-owned interfaces with D1 as one adapter, so that move
adds an adapter rather than rewriting every handler. Drizzle reinforces this — the
same query syntax targets both.

### 13.2 Frontend

**TanStack Start on Cloudflare Workers, in a separate repository.** Server-rendered
throughout, which covers SEO on the public programme and event pages; the
authenticated app (dynamic forms, admin console) is behind login where indexing is
irrelevant but SSR costs nothing given the Service Binding.

Two repositories mean no compile-time link between API and client. A shared types
package or generated client should land early — otherwise an API change breaks the
frontend silently.

### 13.3 Indexing dynamic fields

When admins need to filter or sort by a specific configured field, add a generated
column and index it:

```sql
ALTER TABLE field_values ADD COLUMN value_text TEXT
  GENERATED ALWAYS AS (json_extract(value, '$')) VIRTUAL;
CREATE INDEX idx_field_values_lookup
  ON field_values (field_definition_id, value_text);
```

Do this in response to a measured slow query, not preemptively for every field.

### 13.4 Environments

Three Workers environments (`dev`, `staging`, `production`) with separate D1, R2,
KV, and Queues bindings. Secrets via Wrangler. Migrations version-controlled and
applied in CI. Staging must carry the notification kill-switch from §8.4.

### 13.5 Observability

Structured JSON logs with a request ID propagated through queue messages. Workers
Analytics Engine for counters that matter to operations: transitions per stage,
notification failure rate, upload failure rate, SLA breaches. Alert on notification
delivery failure rate — silent notification failure is this system's quietest and
most damaging outage.

### 13.6 Keeping providers replaceable

The stack is chosen ([ADR 0001](./adr/0001-tech-stack.md)), but the providers within
it were chosen as "decided for now, may change." The adapter layer is what makes
that statement true rather than aspirational.

Hono is a standard Fetch-API framework, so routing and handlers port to Node, Bun,
or Deno with little change. The genuinely Cloudflare-specific surfaces are R2, KV,
Queues, Cron Triggers, and D1 — each sits behind a domain-owned interface
(`storage`, `cache`, `queue`, `db`), as does Pingram (`notifications`). Swapping any
one is a new adapter, not a rewrite.

---

## 14. Build sequence

Each phase should be independently demonstrable.

| Phase | Contents |
|---|---|
| **0 — Spike** | Prove the three unverified integrations before anything depends on them: better-auth on Workers with a Drizzle D1 adapter; TanStack Start deploying to Workers with a Service Binding reachable from server functions; Pingram's real API (auth, webhooks, OTP, SMS coverage). A day here beats discovering a blocker after the foundation is built. |
| **1 — Foundation** | Users, startups, sessions, roles/permissions, audit log, migrations, environments. |
| **2 — Configuration** | Stage/field/document/transition definitions + admin CRUD + snapshot compiler and cache. Nothing applicant-facing yet — but this is the product's spine and must come first. |
| **3 — Application runtime** | Applications, stage instances, dynamic form rendering, `outstanding()`, transitions, decision log. |
| **4 — Documents** | Presigned upload/download, versioning, review flow, expiry cron, scanning. |
| **5 — Notifications** | In-app inbox, templates, triggers, provider adapter, queue, preferences, delivery webhooks. |
| **6 — Programme surfaces** | Announcements, events with registration and reminders, support desk. |
| **7 — Reporting and hardening** | Admin dashboards, funnel and SLA reporting, exports, rate limiting, load check. |

Phase 2 before Phase 3 is deliberate and worth defending: building the application
runtime first invariably produces hardcoded stages that Phase 2 then has to tear out.

---

## 15. Open questions

Resolved questions are recorded in [ADR 0001](./adr/0001-tech-stack.md) and
[ADR 0002](./adr/0002-codebase-structure.md). What remains:

1. **Reviewer assignment** — is any reviewer allowed to decide any application, or
   are applications assigned to specific reviewers? Assignment implies a workload
   view, reassignment, and a "my queue" screen; open access implies neither. The
   duplicate gate (§7.5) reduces the risk of uncoordinated approvals but does not
   remove the question.
2. **Re-application** — may a rejected startup apply to a later round? This decides
   whether `UNIQUE (startup_id, round_id)` is sufficient, and whether identity
   `unique_scope` should default to `round` rather than `global`.
3. **Malware scanning provider** — the approach is settled (third-party scanning
   plus frontend and backend validation, §7.3) but the service is not chosen. The
   `MalwareScanner` port can be written before the decision.
4. **Post-acceptance stage design** — the programme runs on the platform after
   acceptance, and the stage engine already supports that with configuration. What
   is undecided is which post-acceptance features earn their place: progress
   reports, mentor matching, cohort dashboards.
5. **Cold storage retrieval SLA** — R2 Infrequent Access retrieval is slower and
   billed on read. Is that acceptable for a reviewer opening a year-old document,
   or should recently-archived records stay warm?
6. **Event capacity policy** — waitlist promotion is automatic or manual? Affects
   whether a cron job or an admin action drives it.

**Answered since first draft:** single-founder applications (§4.1) · rounds
supporting both batched and continuous intake (§4.2) · post-acceptance lifecycle
(§4.6) · review outcomes and the duplicate gate (§7.4, §7.5) · Pingram confirmed
(§8.3) · retention and archival (§7.7) · localisation (§10) · better-auth schema
ownership (§12) · API/client contract (ADR 0001).

---

## 16. Rules for anyone writing code here

1. **No hardcoded stages, fields, or document types.** Ever. §1.1.
2. **Server decides.** The client renders configuration and displays results; it
   never determines what is required or which transitions are legal.
3. **Configuration is append-only.** Archive, never delete.
4. **Transitions are atomic and audited.** One transaction, one log entry, always.
5. **Notifications never block the action that triggered them.**
6. **All uploads are untrusted.** Validate at presign and confirm; never serve R2
   directly; scan before reviewers open anything.
7. **Isolate the platform.** Cloudflare primitives live behind internal interfaces.

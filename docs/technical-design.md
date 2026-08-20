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

We deliberately do not build for multi-tenancy, but §14.2 records the seams where
it would be introduced if that changes.

---

## 2. Actors

| Actor | Description |
|---|---|
| **Applicant (founder)** | A person who signs up. Belongs to exactly one startup. |
| **Startup** | The applying entity. May have several founders as members. Owns one application. |
| **Reviewer** | Programme staff who evaluate applications and approve documents. |
| **Admin** | Programme staff who configure stages, fields, documents, templates, events. |
| **Support agent** | Handles support tickets. Often the same humans as reviewers. |
| **System** | Scheduled jobs — SLA checks, reminders, document expiry, scheduled publishes. |

Roles are data (§11), not enum constants. "Reviewer" and "Admin" are seeded rows,
and permissions are granted per role.

---

## 3. Architecture overview

**Runtime:** Hono on Cloudflare Workers.
**Chosen for now, may change** as requirements firm up — see §12.6 for what a move
would cost.

```
                          ┌──────────────────────────────┐
   Browser ──────────────▶│  Hono Worker (API + SSR/SPA) │
   (applicant / admin)    └──────────────┬───────────────┘
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
  id, name, slug UNIQUE, website,
  status (draft | active | withdrawn),
  created_at, updated_at
  -- all other startup profile data lives in field_values (§4.3)

startup_members
  id, startup_id, user_id,
  role (owner | member),
  invited_by, invited_at, accepted_at
  UNIQUE (startup_id, user_id)

sessions
  id, user_id, expires_at, ip, user_agent, created_at
```

Note that `startups` has almost no columns. Everything a programme wants to know
about a startup — sector, stage of company, revenue, team size — is admin-configured
and therefore lives in `field_values`. Only fields the *system itself* needs to
function (name, slug) are real columns.

### 4.2 Stage configuration

```
stage_definitions
  id, key UNIQUE, name, description,
  order_index,
  kind (form | review | action_required | terminal),
  applicant_visible BOOL,        -- can applicants see this stage exists?
  sla_days INT NULL,             -- expected time to decide
  is_entry BOOL,                 -- the stage new applications start in
  archived_at NULL

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

### 4.3 Dynamic fields

```
field_definitions
  id,
  stage_id NULL,                  -- NULL = startup profile field, not stage-bound
  key, label, help_text,
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
sort on (§12.3). Start simple; add indexes when a real query is slow.

### 4.4 Document requirements

```
document_requirements
  id,
  stage_id NULL,                  -- NULL = required regardless of stage
  key, name, description,
  required BOOL,
  accepted_mime_types JSON,       -- ["application/pdf", "image/png"]
  max_size_bytes, max_files,
  expires_after_days INT NULL,    -- e.g. certificate valid 12 months
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

### 4.5 Application runtime

```
applications
  id, startup_id UNIQUE,
  current_stage_id,
  status (draft | active | withdrawn | rejected | accepted | completed),
  config_version INT,             -- see §5.5
  submitted_at, created_at, updated_at

application_stage_instances
  id, application_id, stage_id,
  status (pending | in_progress | submitted | under_review
          | changes_requested | approved | rejected | skipped),
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

### 4.6 Notifications

```
notification_templates
  id, key UNIQUE, name,
  subject_template, body_template,   -- variable interpolation, §8.2
  sms_template NULL,
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

### 4.7 Events, announcements, support

```
events
  id, title, description,
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
  id, title, body,
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

### 4.8 Audit

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

### 5.5 Configuration versioning — the hard problem

An admin edits stage configuration while forty applications are mid-flight. What
happens to them?

**Rules:**

1. **Configuration rows are never hard-deleted**, only `archived_at`. An archived
   field still renders its historical value on applications that captured it.
2. **Applications pin `config_version`** at creation. Their checklist is evaluated
   against the snapshot they were admitted under.
3. **Admins may explicitly migrate** an application (or a filtered set) to the
   current version, which is an audited action showing what becomes newly
   outstanding.
4. **Adding an optional field or a non-required document** is safe and applies
   immediately to everyone.
5. **Adding a required item, removing a stage, or reordering stages** is a
   version-bumping change requiring explicit migration.

Getting this wrong produces the worst possible bug class: an applicant who
completed everything is silently marked incomplete, or worse, is advanced past a
document that is now mandatory. Build this in from the start — retrofitting version
pinning after launch means reconciling live data by hand.

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

### 7.4 Expiry

Requirements with `expires_after_days` set `document_submissions.expires_at` on
approval. A daily cron flips lapsed rows to `expired` and fires
`document.expired`, which reopens the requirement in the applicant's checklist.

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

## 10. API design

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

## 11. Authentication and authorisation

**Authentication** — email + password with verification, sessions in KV keyed by an
opaque token in an `HttpOnly; Secure; SameSite=Lax` cookie. Prefer server-side
sessions over JWTs: staff need the ability to revoke immediately. Phone
verification by OTP through the §8.3 provider. Turnstile on signup. Add WebAuthn or
SSO for staff later if warranted.

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

## 12. Platform decisions

### 12.1 D1 vs Postgres

**Recommendation: D1 to start.**

D1 is SQLite: it is co-located with Workers, requires no connection pooling, has no
idle cost, and comfortably handles a programme's volume (thousands of applications,
not millions). SQLite's JSON1 functions plus generated columns cover the dynamic-field
queries described in §12.3.

Constraints to respect: a 10 GB database limit (documents live in R2, so rows stay
small), no long-lived transactions, and modest write concurrency — all acceptable
for admin-paced workloads.

**If** reporting needs grow into complex ad-hoc analytics over dynamic fields,
Postgres via Hyperdrive with `jsonb` and GIN indexes is the escape hatch. Keep all
database access behind a repository layer so that move touches one directory rather
than every handler.

### 12.2 Frontend

A Hono-served SPA (React) is the straightforward path, given how much of the UI is
dynamic forms driven by runtime configuration — the admin console in particular is
highly interactive and gains little from SSR. Public marketing pages and the
programme's public event listings should be server-rendered for SEO.

### 12.3 Indexing dynamic fields

When admins need to filter or sort by a specific configured field, add a generated
column and index it:

```sql
ALTER TABLE field_values ADD COLUMN value_text TEXT
  GENERATED ALWAYS AS (json_extract(value, '$')) VIRTUAL;
CREATE INDEX idx_field_values_lookup
  ON field_values (field_definition_id, value_text);
```

Do this in response to a measured slow query, not preemptively for every field.

### 12.4 Environments

Three Workers environments (`dev`, `staging`, `production`) with separate D1, R2,
KV, and Queues bindings. Secrets via Wrangler. Migrations version-controlled and
applied in CI. Staging must carry the notification kill-switch from §8.4.

### 12.5 Observability

Structured JSON logs with a request ID propagated through queue messages. Workers
Analytics Engine for counters that matter to operations: transitions per stage,
notification failure rate, upload failure rate, SLA breaches. Alert on notification
delivery failure rate — silent notification failure is this system's quietest and
most damaging outage.

### 12.6 On the stack being provisional

Hono is a standard Fetch-API framework, so the routing and handler layer ports to
Node, Bun, or Deno with little change. The genuinely Cloudflare-specific surfaces
are R2 bindings, KV, Queues, Cron Triggers, and D1. Isolating each behind a thin
internal interface (`storage`, `cache`, `queue`, `db`) keeps a platform change
bounded. That isolation is worth doing precisely because the stack is not final.

---

## 13. Build sequence

Each phase should be independently demonstrable.

| Phase | Contents |
|---|---|
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

## 14. Open questions

1. **Multi-founder startups** — the model assumes several founders may share one
   application. Confirm; if applications are strictly one-person, `startup_members`
   collapses and the model simplifies considerably.
2. **Cohorts** — do programmes run in rounds (Spring 2027, Autumn 2027) with
   separate configurations and separate applicant pools? If so, a `cohorts` table
   should be introduced now, not retrofitted, since it scopes applications,
   stages, and events.
3. **Post-acceptance lifecycle** — does an accepted startup keep using the platform
   during the programme, or is acceptance the terminal state? This determines
   whether stages continue past acceptance and how much weight events carry.
4. **Reviewer scoring** — is evaluation freeform notes, or structured scoring with
   multiple reviewers and aggregation? Structured scoring is a subsystem, not a field.
5. **Pingram's capabilities** — confirm OTP support, SMS coverage for the applicant
   regions, delivery webhooks, and pricing before committing (§8.3).
6. **Malware scanning** — choose an approach (§7.3).
7. **Data retention** — how long are rejected applicants' documents kept, and what
   obligations apply in the operating jurisdiction?
8. **Localisation** — one language, or several? Templates and field labels are the
   affected surfaces, and retrofitting translation into configuration rows is
   painful.

---

## 15. Rules for anyone writing code here

1. **No hardcoded stages, fields, or document types.** Ever. §1.1.
2. **Server decides.** The client renders configuration and displays results; it
   never determines what is required or which transitions are legal.
3. **Configuration is append-only.** Archive, never delete.
4. **Transitions are atomic and audited.** One transaction, one log entry, always.
5. **Notifications never block the action that triggered them.**
6. **All uploads are untrusted.** Validate at presign and confirm; never serve R2
   directly; scan before reviewers open anything.
7. **Isolate the platform.** Cloudflare primitives live behind internal interfaces.

# sebp — Documentation

sebp is the platform on which a startup programme runs. Startups sign up, apply,
upload required documents, and are advanced by the programme team through a
configurable series of stages.

**The defining constraint:** stages, the data captured at each stage, and the
documents each stage requires are all configuration edited by admins at runtime —
never hardcoded. Read [§1.1 of the technical design](./technical-design.md#11-the-defining-constraint)
before writing any code.

---

## Documents

| Document | Audience | What it covers |
|---|---|---|
| **[Platform Overview](./platform-overview.md)** | Clients, stakeholders, non-technical readers | What sebp does, the applicant journey, the programme team's capabilities, the full feature list in plain language, and delivery phases. Safe to share externally. |
| **[Technical Design](./technical-design.md)** | Engineering | Data model, stage engine, dynamic forms, document handling, notification pipeline, API surface, auth model, platform decisions, and build sequence. |

---

## Quick reference

**Domain** — a single-organisation startup programme. One programme team, one
applicant pool, no multi-tenancy.

**Stack** *(provisional)* — Hono on Cloudflare Workers · D1 for rows · R2 for
documents · KV for config cache and sessions · Queues for notification fan-out ·
Cron Triggers for reminders, SLA checks, and document expiry · Pingram for email
and SMS.

**Subsystems**

| Area | Summary |
|---|---|
| Applications & stages | The configurable pipeline applicants move through |
| Documents | Versioned upload, review, approval, expiry |
| In-app notifications | Notification centre inside the platform |
| External notifications | Email and SMS, with admin-editable templates and triggers |
| Announcements | Targeted, schedulable posts to applicant groups |
| Events | Programme sessions with registration, capacity, and reminders |
| Support | Ticketed help desk with threaded replies and internal notes |
| Roles & permissions | Data-driven roles for reviewers, admins, and support staff |

---

## Build sequence

Configuration comes before the applicant experience. This looks backwards — Phase 2
ships nothing an applicant sees — but building the applicant flow first reliably
produces hardcoded stages that then have to be torn out.

1. **Foundation** — users, startups, sessions, roles, audit log
2. **Configuration** — stage/field/document definitions, admin CRUD, snapshot cache
3. **Application runtime** — dynamic forms, outstanding-items engine, transitions
4. **Documents** — presigned upload/download, versioning, review, expiry
5. **Notifications** — in-app, email, SMS, templates, triggers, preferences
6. **Programme surfaces** — announcements, events, support desk
7. **Reporting & hardening** — dashboards, funnel reporting, exports, rate limiting

Full detail in [§13](./technical-design.md#13-build-sequence).

---

## Rules for contributors

1. **No hardcoded stages, fields, or document types.** Ever.
2. **Server decides.** The client renders configuration; it never determines what is
   required or which transitions are legal.
3. **Configuration is append-only.** Archive, never delete.
4. **Transitions are atomic and audited.** One transaction, one log entry.
5. **Notifications never block the action that triggered them.**
6. **All uploads are untrusted.** Validate at presign and confirm; never serve R2
   directly; scan before reviewers open anything.
7. **Isolate the platform.** Cloudflare primitives live behind internal interfaces —
   the stack is not final.

Expanded in [§15](./technical-design.md#15-rules-for-anyone-writing-code-here).

---

## Open questions

Decisions still needed, roughly in order of how expensive they get to defer:

| # | Question | Why it matters |
|---|---|---|
| 1 | Do co-founders share one application? | Currently modelled as yes. If no, the data model simplifies considerably. |
| 2 | Does the programme run in cohorts/rounds? | Scopes applications, stages, and events — retrofitting is painful. |
| 3 | What happens after acceptance? | Determines whether stages continue past selection. |
| 4 | Freeform review notes or structured scoring? | Structured scoring is a subsystem, not a field. |
| 5 | Pingram's actual capabilities | OTP support, SMS coverage, webhooks — unverified. |
| 6 | Malware scanning approach | Cloudflare has no native object scanning. Unresolved. |
| 7 | Document retention for rejected applicants | Jurisdictional obligations. |
| 8 | Localisation | Affects templates and field labels stored as configuration. |

Full context in [§14](./technical-design.md#14-open-questions).

---

## Pad workspace

This project is tracked in a [Pad](https://getpad.dev) workspace — the two documents
above also exist there as **DOC-8** (technical) and **DOC-9** (overview), alongside
the project's conventions and playbooks.

Pad runs in local mode, so that workspace lives in a SQLite database on one machine
and syncs nowhere. `.pad.toml` in the repository root is only a pointer to it.
Cloning this repo does **not** bring the workspace with it.

[`docs/pad-export/`](./pad-export/) holds the actual backup and a restore path —
see its [README](./pad-export/README.md).

The markdown files in this directory are the source of truth for documentation; the
Pad copies are a convenience. Keep them in sync when either changes.

# sebp — Codebase Structure and Engineering Rules

**Status:** Living document · **Last updated:** 2026-08-20
**Decisions recorded in:** [ADR 0001](./adr/0001-tech-stack.md) · [ADR 0002](./adr/0002-codebase-structure.md)

This document is the contract for how code in sebp is written. It is prescriptive
on purpose — several rules exist to protect [the defining
constraint](./technical-design.md#11-the-defining-constraint) that nothing about
the programme's shape is hardcoded, and several more exist so that multiple agents
can work in parallel without colliding.

If a rule here conflicts with your instinct, the rule wins. If a rule here is
wrong, change the document — do not quietly work around it.

---

## Contents

1. [The two repositories](#1-the-two-repositories)
2. [API repository layout](#2-api-repository-layout)
3. [Anatomy of a module](#3-anatomy-of-a-module)
4. [The public surface rule](#4-the-public-surface-rule)
5. [Dependency direction](#5-dependency-direction)
6. [Ports catalogue](#6-ports-catalogue)
7. [The better-auth exception](#7-the-better-auth-exception)
8. [Error model](#8-error-model)
9. [Commands and queries](#9-commands-and-queries)
10. [Composition root](#10-composition-root)
11. [HTTP layer and OpenAPI](#11-http-layer-and-openapi)
12. [Database and migrations](#12-database-and-migrations)
13. [Testing rules](#13-testing-rules)
14. [Enforcement](#14-enforcement)
15. [Frontend repository](#15-frontend-repository)
16. [The contract between repositories](#16-the-contract-between-repositories)
17. [Naming conventions](#17-naming-conventions)
18. [Git workflow](#18-git-workflow)
19. [Adding a feature — checklist](#19-adding-a-feature--checklist)

---

## 1. The two repositories

| Repo | Contains | Runtime |
|---|---|---|
| **`sebp-api`** | All domain logic, persistence, notifications, scheduled work | Hono on Cloudflare Workers |
| **`sebp-web`** | Public pages, applicant app, admin console | TanStack Start on Cloudflare Workers |

`sebp-web` reaches `sebp-api` through a **Service Binding** — a direct
Worker-to-Worker call with no network hop. The API needs no public exposure to
serve SSR traffic.

The API is the only thing that talks to the database. The frontend has no database
access of any kind, ever.

---

## 2. API repository layout

```
sebp-api/
├── src/
│   ├── modules/                 # one directory per subsystem
│   │   ├── identity/
│   │   ├── stage-config/
│   │   ├── application/
│   │   ├── document/
│   │   ├── notification/
│   │   ├── event/
│   │   ├── announcement/
│   │   ├── support/
│   │   └── audit/
│   │
│   ├── platform/                # concrete infrastructure, owned by no module
│   │   ├── d1/
│   │   │   ├── client.ts        # drizzle instance
│   │   │   ├── schema/          # drizzle table definitions
│   │   │   └── migrations/      # ordered SQL, single sequence
│   │   ├── r2/storage.ts        # implements ObjectStorage
│   │   ├── kv/store.ts          # implements KeyValueStore
│   │   ├── queue/job-queue.ts   # implements JobQueue
│   │   ├── pingram/notifier.ts  # implements Notifier
│   │   ├── clock.ts             # implements Clock
│   │   └── ids.ts               # implements IdGenerator
│   │
│   ├── shared/                  # pure, zero dependencies
│   │   ├── result.ts
│   │   ├── errors.ts
│   │   ├── ids.ts               # branded id types
│   │   └── audience.ts          # audience spec shared by 3 modules
│   │
│   ├── ports/                   # cross-cutting port interfaces
│   │   ├── clock.ts
│   │   ├── id-generator.ts
│   │   ├── object-storage.ts
│   │   ├── key-value-store.ts
│   │   ├── job-queue.ts
│   │   └── notifier.ts
│   │
│   ├── http/
│   │   ├── app.ts               # root Hono app, mounts module routers
│   │   ├── middleware/
│   │   │   ├── auth.ts          # better-auth session → UserId
│   │   │   ├── error.ts         # Result error → HTTP status
│   │   │   └── request-id.ts
│   │   └── openapi.ts           # serves /openapi.json
│   │
│   ├── container.ts             # composition root — the ONLY wiring point
│   └── index.ts                 # Worker entry: fetch / queue / scheduled
│
├── test/
│   ├── e2e/                     # mirrors modules/
│   ├── fixtures/                # seed builders — first-class code
│   └── setup.ts
│
├── dependency-cruiser.cjs
├── drizzle.config.ts
├── vitest.config.ts
├── wrangler.toml
└── package.json
```

**`platform/` vs `modules/*/adapters/`.** Infrastructure that every module uses
(the Drizzle client, R2, KV, Queues, Pingram, clock, ids) lives in `platform/` and
implements a cross-cutting port from `src/ports/`. Adapters specific to one module
— its repositories and queries — live inside that module.

---

## 3. Anatomy of a module

Every module has the same internal shape. `application` as the worked example:

```
modules/application/
├── index.ts                     # PUBLIC SURFACE — the only importable file
│
├── domain/                      # pure. no framework, no cloudflare, no drizzle
│   ├── application.ts           # entity + invariants
│   ├── stage-instance.ts
│   ├── outstanding.ts           # §5.2 of the technical design — a pure function
│   ├── transition.ts            # legality + gate evaluation
│   └── errors.ts                # ApplicationError union
│
├── ports/                       # interfaces THIS module owns
│   ├── application-repo.ts      # command side — returns domain entities
│   ├── stage-instance-repo.ts
│   └── application-queries.ts   # query side — returns read-model DTOs
│
├── use-cases/                   # orchestration: domain + ports, no framework
│   ├── advance-application.ts
│   ├── submit-stage.ts
│   └── withdraw-application.ts
│
├── adapters/                    # PRIVATE. implementations of this module's ports
│   └── d1/
│       ├── application-repo.ts
│       ├── stage-instance-repo.ts
│       └── application-queries.ts
│
└── http/                        # PRIVATE. Hono router for this module
    ├── routes.ts
    └── schemas.ts               # zod request/response, feeds OpenAPI
```

**Why the same shape every time:** an agent that has worked in one module can work
in any module. Predictability beats cleverness here.

---

## 4. The public surface rule

> **A module's `index.ts` is its entire public surface. Everything else is private.**

`index.ts` exports exactly three kinds of thing:

```ts
// modules/application/index.ts

// 1. Domain types other modules may reference
export type { Application, StageInstance, ApplicationStatus } from './domain/application'
export type { ApplicationError } from './domain/errors'

// 2. Port interfaces other modules may depend on
export type { ApplicationRepo } from './ports/application-repo'
export type { ApplicationQueries } from './ports/application-queries'

// 3. A factory the composition root calls
export { createApplicationModule } from './module'
```

It exports **no adapters, no routes, no internal domain helpers**.

### Cross-module rules

| Rule | |
|---|---|
| ✅ | `import type { Application } from '@/modules/application'` |
| ✅ | Depend on another module's **port interface**, injected via the container |
| ❌ | `import { D1ApplicationRepo } from '@/modules/application/adapters/d1/application-repo'` |
| ❌ | `import { evaluateGate } from '@/modules/application/domain/transition'` |
| ❌ | Any import path with more than one segment after the module name |

The last rule is the mechanical one: **from outside a module, the only legal import
path is `@/modules/<name>`.** Deep paths are a lint error, not a code-review note.

### When module A needs behaviour from module B

Depend on B's port, and let the container inject B's implementation:

```ts
// modules/notification/use-cases/send-stage-notification.ts
import type { ApplicationQueries } from '@/modules/application'   // ✅ port only

export function sendStageNotification(deps: {
  applications: ApplicationQueries
  notifier: Notifier
  clock: Clock
}) { /* ... */ }
```

If two modules need to reach into each other's internals, that is a signal the
boundary is drawn in the wrong place. Move the code — do not widen the surface.

---

## 5. Dependency direction

Dependencies point **inward**. `domain/` is the centre and knows nothing.

| Layer | May import |
|---|---|
| `shared/` | nothing |
| `domain/` | `shared/`, its own module's `domain/` |
| `ports/` | `shared/`, its own module's `domain/` |
| `use-cases/` | `shared/`, `domain/`, `ports/`, other modules' **barrels** |
| `adapters/` | everything above + `platform/`, Drizzle, Cloudflare types |
| `http/` | its own module's `use-cases/`, `ports/`, `domain/`, Hono, Zod |
| `container.ts` | everything |

### Absolute rules

1. **`domain/` imports no framework.** No Hono, no Drizzle, no Zod, no
   `cloudflare:workers`, no `better-auth`. If you need the current time or a new
   id, take a `Clock` or `IdGenerator` port as an argument.
2. **`domain/` never performs I/O.** Pure functions and entities only.
3. **Repositories return domain entities, not database rows.** Mapping happens in
   the adapter. A Drizzle row type must never escape `adapters/`.
4. **No module imports `platform/` outside its own `adapters/`.**
5. **Nothing imports `container.ts` except `index.ts`.**

> `Date.now()`, `new Date()`, `Math.random()`, and `crypto.randomUUID()` are banned
> in `domain/` and `use-cases/`. They make behaviour untestable and time-dependent.
> Use the `Clock` and `IdGenerator` ports.

---

## 6. Ports catalogue

Anything that might plausibly be swapped is a port. That includes infrastructure
we have no current intention of changing — the point is that the decision stays
cheap.

### Cross-cutting (`src/ports/`)

```ts
export interface Clock {
  now(): Date
}

export interface IdGenerator {
  next(): string                      // UUIDv7, time-sortable
}

export interface ObjectStorage {       // R2 today
  presignPut(key: string, opts: PresignOptions): Promise<Result<PresignedUrl, StorageError>>
  presignGet(key: string, ttlSeconds: number): Promise<Result<PresignedUrl, StorageError>>
  delete(key: string): Promise<Result<void, StorageError>>
  head(key: string): Promise<Result<ObjectMetadata | null, StorageError>>
}

export interface KeyValueStore {       // KV today
  get<T>(key: string): Promise<Result<T | null, CacheError>>
  put<T>(key: string, value: T, ttlSeconds?: number): Promise<Result<void, CacheError>>
  delete(key: string): Promise<Result<void, CacheError>>
}

export interface JobQueue {            // Cloudflare Queues today
  enqueue(job: Job): Promise<Result<void, QueueError>>
  enqueueBatch(jobs: Job[]): Promise<Result<void, QueueError>>
}

export interface Notifier {            // Pingram today
  sendEmail(msg: EmailMessage): Promise<Result<ProviderReceipt, NotifierError>>
  sendSms(msg: SmsMessage): Promise<Result<ProviderReceipt, NotifierError>>
}
```

### Module-owned

Each module declares its own repository and query ports in `modules/<name>/ports/`.
They are named for what they do, not for what implements them — `ApplicationRepo`,
never `D1ApplicationRepo`. The implementation carries the technology in its name.

**The rule for adding a port:** if replacing the thing behind it would otherwise
mean editing files outside `adapters/` and `platform/`, it needs a port.

---

## 7. The better-auth exception

better-auth is the single sanctioned exception to §5 and §6. It is **not** wrapped
in a port, because it owns its own schema (`user`, `session`, `account`,
`verification`) and its own middleware, and wrapping it means fighting it
continuously.

The exception is bounded:

| | |
|---|---|
| ✅ | `modules/identity/` may import better-auth directly |
| ✅ | `http/middleware/auth.ts` may import better-auth directly |
| ❌ | **Every other module** — must never import or reference it |
| ❌ | `domain/` in any module, including `identity` |

Everything downstream of the middleware sees a plain branded `UserId`:

```ts
// shared/ids.ts
export type UserId = string & { readonly __brand: 'UserId' }
```

Consequences to be aware of:

- better-auth's tables are **library-shaped, not domain-shaped**. The `users` table
  sketched in [technical-design.md §4.1](./technical-design.md#41-identity) does not
  survive contact with it unchanged — `modules/identity` owns the reconciliation.
- Domain concepts that are *not* authentication — `Startup`, `StartupMember`,
  programme roles and permissions — are ours, live in `modules/identity/domain/`,
  and are keyed by `UserId`. Do not push them into better-auth's schema.
- If better-auth is ever replaced, the blast radius is `modules/identity` plus one
  middleware file. That is the exception's justification.

---

## 8. Error model

**Failures are return values.** `Result<T, E>` throughout `domain/` and
`use-cases/`.

```ts
// shared/result.ts
export type Result<T, E> =
  | { readonly ok: true;  readonly value: T }
  | { readonly ok: false; readonly error: E }

export const ok  = <T>(value: T): Result<T, never> => ({ ok: true, value })
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error })
```

Errors are discriminated unions owned by the module:

```ts
// modules/application/domain/errors.ts
export type ApplicationError =
  | { kind: 'not_found' }
  | { kind: 'illegal_transition'; from: StageId; to: StageId }
  | { kind: 'missing_required_fields'; fields: string[] }
  | { kind: 'documents_not_approved'; requirements: string[] }
  | { kind: 'stale_write' }                    // optimistic concurrency lost
  | { kind: 'forbidden'; permission: string }
```

The HTTP layer maps error kinds to status codes in one place
(`http/middleware/error.ts`) — never scattered through routes.

| kind | status |
|---|---|
| `not_found` | 404 |
| `forbidden` | 403 |
| `illegal_transition`, `stale_write` | 409 |
| `missing_required_fields`, `documents_not_approved` | 422 + field detail |

### When throwing is allowed

`throw` is reserved for **programmer error** — states that indicate a bug, not a
user or infrastructure condition. A thrown error is a 500 and a bug report.

Because of the 100% coverage gate (§13), do not write defensive guards for states
the type system already prevents. If a branch cannot be reached by any request,
it is dead code — delete it, or change the types so the state is unrepresentable.

---

## 9. Commands and queries

The two sides have different shapes and different ports.

| | Command side | Query side |
|---|---|---|
| Port | `ApplicationRepo` | `ApplicationQueries` |
| Returns | Domain entities | Read-model DTOs |
| Used by | `use-cases/` | `http/` routes directly |
| Purpose | Enforce invariants, mutate | Render screens |

```ts
// ports/application-repo.ts — command side
export interface ApplicationRepo {
  findById(id: ApplicationId): Promise<Result<Application | null, RepoError>>
  save(application: Application): Promise<Result<void, RepoError>>
  advance(input: AdvanceInput): Promise<Result<void, RepoError | 'stale_write'>>
}

// ports/application-queries.ts — query side
export interface ApplicationQueries {
  list(filter: ApplicationFilter, page: Cursor): Promise<Result<Page<ApplicationListItem>, RepoError>>
  detail(id: ApplicationId): Promise<Result<ApplicationDetail | null, RepoError>>
  funnelCounts(): Promise<Result<StageCount[], RepoError>>
}
```

**Queries may read across tables freely and project straight to the DTO in SQL.**
Do not hydrate an aggregate to render a list — that is the whole reason the split
exists, and it matters most for dynamic-field filtering where the query needs
`json_extract` and generated columns rather than domain objects.

**Queries never mutate.** A query port with a write method is a bug.

---

## 10. Composition root

`container.ts` is the only file that constructs adapters. It is the seam that makes
every port swappable.

```ts
// container.ts
export function buildContainer(env: Env) {
  // platform
  const db       = createDrizzle(env.DB)
  const clock    = systemClock()
  const ids      = uuidV7Generator()
  const storage  = r2Storage(env.DOCUMENTS)
  const cache    = kvStore(env.CONFIG)
  const queue    = cfJobQueue(env.JOBS)
  const notifier = pingramNotifier(env.PINGRAM_API_KEY)

  // modules — each returns { useCases, queries, router }
  const identity     = createIdentityModule({ db, clock, ids, env })
  const stageConfig  = createStageConfigModule({ db, cache, clock, ids })
  const application  = createApplicationModule({ db, clock, ids, stageConfig: stageConfig.queries })
  const document     = createDocumentModule({ db, storage, clock, ids, queue })
  const notification = createNotificationModule({ db, notifier, queue, clock, ids })
  // ...

  return { identity, stageConfig, application, document, notification, /* ... */ }
}
```

Rules:

- No module constructs another module. The container does.
- No adapter is instantiated anywhere else — not in a route, not in a use-case, not
  in a test helper.
- Modules receive **ports**, never the container itself. Passing the container is
  service-locator, and it defeats the point.

---

## 11. HTTP layer and OpenAPI

Routes are thin. A route does exactly four things:

1. Validate input with Zod.
2. Resolve the caller's `UserId` and permissions from middleware.
3. Call one use-case or one query.
4. Map the `Result` to a response.

Business logic in a route handler is a bug.

```ts
// modules/application/http/routes.ts
app.openapi(advanceRoute, async (c) => {
  const { id } = c.req.valid('param')
  const body   = c.req.valid('json')
  const actor  = c.get('actor')

  const result = await useCases.advanceApplication({ id, actor, ...body })
  return result.ok
    ? c.json(toResponse(result.value), 200)
    : mapError(c, result.error)
})
```

**OpenAPI is generated, never hand-written.** Routes are declared with
`@hono/zod-openapi`, so the same Zod schema validates the request and describes it
in the spec — they cannot drift. `/openapi.json` is served by `http/openapi.ts`.

Cross-cutting HTTP conventions:

- Cursor pagination: `?cursor=&limit=`
- `409` for state conflicts, `422` with a per-field error map for validation
- Every mutation accepts `Idempotency-Key` — a retried stage transition must not
  double-advance an applicant

---

## 12. Database and migrations

- **One migration sequence** in `platform/d1/migrations/`, applied in order.
  Modules do not own separate migration streams; D1 has one schema.
- Drizzle table definitions live in `platform/d1/schema/`, one file per module's
  tables, re-exported from an index.
- Migrations are **forward-only**. No down-migrations; correct a bad migration with
  a new one.
- Never edit an applied migration. Ever.
- Configuration tables are **append-only** — archive with `archived_at`, never
  `DELETE`. See [technical-design.md §5.5](./technical-design.md#55-configuration-versioning--the-hard-problem)
  for why this is load-bearing rather than fastidious.

---

## 13. Testing rules

This section is the one most likely to be argued with. The decisions are recorded
in [ADR 0002](./adr/0002-codebase-structure.md) along with their costs.

### The rules

1. **Backend tests run through HTTP.** Every test issues a real request against the
   Hono app. There are no unit tests of domain functions, no direct calls into
   use-cases from tests.
2. **Real infrastructure.** Real D1, R2, KV, and Queues via
   `@cloudflare/vitest-pool-workers`. Isolated storage per test.
3. **No mocking of external libraries.** Not better-auth, not Drizzle, not the
   Workers runtime.
4. **Port substitution is permitted for failure paths only.** Swapping in an
   implementation of *your own port* that returns an error is exercising your
   contract, not faking someone else's library. It is the only sanctioned way to
   reach `StorageError`, `QueueError`, and `NotifierError` branches — no HTTP
   request can make R2 fail on demand.
5. **100% coverage, enforced.** CI fails below it, in both repositories.
6. **Frontend uses Playwright**, also at 100%, via Istanbul instrumentation of the
   built bundle.

### What rule 4 does and does not allow

```ts
// ✅ ALLOWED — triggering a failure branch that HTTP cannot reach
const failingStorage: ObjectStorage = {
  ...realStorage,
  presignPut: async () => err({ kind: 'storage_unavailable' }),
}
const app = buildTestApp({ storage: failingStorage })
// assert the route returns 503 and no document row was written

// ❌ NOT ALLOWED — substituting to avoid setting up real state
const fakeRepo: ApplicationRepo = { findById: async () => ok(someFixture) }
```

The distinction: substitution is for **provoking failures that are otherwise
unreachable**, never for convenience or speed. A substituted port on a happy path
is a rule violation and will be rejected in review.

### Fixtures are first-class

HTTP-level tests are only writable if seeding is easy. `test/fixtures/` holds
builders, and they are maintained with the same care as `src/`:

```ts
const startup = await seed.startup({ name: 'Acme' })
const stage   = await seed.stage({ key: 'screening', requires: ['pitch_deck'] })
const app     = await seed.application({ startup, stage })
```

### Working with the 100% gate

- **Delete unreachable code** rather than ignoring it. The gate is a dead-code
  detector; that is its main benefit.
- **Make invalid states unrepresentable** instead of writing defensive branches.
- `/* v8 ignore next */` is permitted **only** for genuine platform edges that
  cannot be provoked even with port substitution, and every use requires a comment
  explaining what cannot be triggered and why.
- A pull request that lowers a coverage threshold is not a fix.

---

## 14. Enforcement

Rules that rely on memory get broken. These are mechanical.

### dependency-cruiser

```js
// dependency-cruiser.cjs
module.exports = {
  forbidden: [
    {
      name: 'domain-is-pure',
      severity: 'error',
      from: { path: 'src/modules/[^/]+/domain' },
      to:   { path: 'node_modules|src/platform|src/modules/[^/]+/(adapters|http)' },
    },
    {
      name: 'no-deep-cross-module-imports',
      severity: 'error',
      from: { path: 'src/modules/([^/]+)/' },
      to:   { path: 'src/modules/(?!$1)[^/]+/.+' },   // anything past the barrel
    },
    {
      name: 'better-auth-is-confined',
      severity: 'error',
      from: { pathNot: 'src/(modules/identity|http/middleware/auth)' },
      to:   { path: 'node_modules/better-auth' },
    },
    {
      name: 'platform-only-from-adapters',
      severity: 'error',
      from: { path: 'src/modules/[^/]+/(domain|ports|use-cases)' },
      to:   { path: 'src/platform' },
    },
    { name: 'no-circular', severity: 'error', from: {}, to: { circular: true } },
  ],
}
```

### ESLint

- `no-restricted-imports` banning `cloudflare:workers`, `drizzle-orm`, and `hono`
  from `domain/` and `use-cases/`
- `no-restricted-globals` banning `Date`, `Math.random`, `crypto.randomUUID` in
  `domain/` and `use-cases/`

### Vitest

```ts
coverage: {
  provider: 'v8',
  thresholds: { lines: 100, functions: 100, branches: 100, statements: 100 },
}
```

### CI gate

`pnpm lint && pnpm depcruise && pnpm test` — all three must pass. This is what
[CONVE-3](./pad-export/conventions.json) refers to.

---

## 15. Frontend repository

```
sebp-web/
├── src/
│   ├── routes/
│   │   ├── (public)/            # SSR, indexable — landing, programme, events
│   │   ├── (auth)/              # login, signup, verification
│   │   ├── (app)/               # applicant — authenticated
│   │   └── (admin)/             # programme team
│   │
│   ├── features/                # mirrors API modules where sensible
│   │   ├── application/
│   │   ├── documents/
│   │   ├── stage-builder/
│   │   ├── notifications/
│   │   ├── events/
│   │   └── support/
│   │
│   ├── components/ui/           # primitives, no domain knowledge
│   │
│   ├── lib/
│   │   ├── api/
│   │   │   ├── generated/       # openapi-typescript output — never hand-edited
│   │   │   └── client.ts        # the ONLY module that calls the API
│   │   ├── auth/
│   │   └── fields/              # one renderer per field data_type
│   │
│   └── styles/
├── e2e/                         # playwright
└── wrangler.toml
```

### Frontend rules

1. **`lib/api/client.ts` is the only place the API is called.** Components never
   `fetch`.
2. **`lib/api/generated/` is build output.** Regenerate; never hand-edit.
3. **The server is authoritative.** The client renders configuration and displays
   results. It never decides what is required or which transitions are legal — it
   may only *display* what the API told it. Duplicating a rule client-side for
   responsiveness is acceptable; treating the client's answer as truth is not.
4. **One renderer per `data_type`, in `lib/fields/`.** Adding a field type means
   adding one renderer. This and the API's validator factory are the only two
   places a switch on field type is allowed.
5. **`features/` never imports from another feature.** Shared code moves to
   `components/ui/` or `lib/`.
6. **Public routes must render meaningful HTML without JavaScript.** That is the
   entire reason SSR was chosen.

---

## 16. The contract between repositories

```
sebp-api  ──[ zod schemas ]──▶  /openapi.json
                                     │
                                     ▼
sebp-web  ──[ openapi-typescript ]──▶  src/lib/api/generated/
```

- The spec is generated from the Zod schemas that validate requests. It cannot
  drift from the implementation.
- `sebp-web` regenerates in CI and **commits** the output, so the diff of an API
  change is visible in the frontend's history.
- A breaking API change is a two-repository change. Ship the additive API change
  first, migrate the frontend, then remove the old shape — the repos deploy
  independently and will be briefly out of step.
- Version the API path (`/api/v1`) and do not repurpose an existing shape.

---

## 17. Naming conventions

| Thing | Convention | Example |
|---|---|---|
| Files | kebab-case | `advance-application.ts` |
| Types, interfaces | PascalCase, no `I` prefix | `ApplicationRepo` |
| Port | Names the capability | `ObjectStorage`, `Notifier` |
| Adapter | Names the technology | `R2ObjectStorage`, `PingramNotifier` |
| Use-case file | verb-noun | `review-document.ts` |
| Factory | `create<Thing>` | `createApplicationModule` |
| Error kinds | snake_case string literals | `illegal_transition` |
| DB tables/columns | snake_case, plural tables | `application_stage_instances` |
| Branded ids | `<Entity>Id` | `ApplicationId` |

Domain vocabulary is fixed by [the technical design](./technical-design.md#4-data-model)
— *application*, *stage*, *stage instance*, *requirement*, *submission*,
*transition*. Do not invent synonyms; a "record" or "entry" in code that means
"application" costs every future reader.

---

## 18. Git workflow

- **One worktree per task**: `git worktree add ../sebp-<task-slug> -b <task-slug>`.
  This is what allows parallel agents to work without colliding.
- **Never commit to `main`.** Feature branch, then PR.
- **Conventional commits**: `feat(stages): …`, `fix(documents): …`. Scopes are
  module names.
- **Self-review the diff before opening a PR** — debug code, stray logging,
  unintended changes.
- **Independent AI review before merge.** Implementation is done with Claude, so
  review runs through `codex` — a different model catches what self-review does not.
- Claim a task atomically before starting:
  `pad item update TASK-N --status in-progress --expected-updated-at <ts>`.
  A non-zero exit means another agent got there first.

---

## 19. Adding a feature — checklist

1. Claim the task in Pad; create a worktree.
2. Decide which **module** owns it. If it spans modules, the boundary may be wrong.
3. Model it in `domain/` first — pure, `Result`-returning, no I/O.
4. Declare or extend a **port** if it needs anything external.
5. Write the **use-case** orchestrating domain + ports.
6. Implement the **adapter**. Map rows to domain entities here, nowhere else.
7. Add the **route** with Zod schemas; keep it thin.
8. Wire it in `container.ts` if a new dependency appeared.
9. Add a **migration** if the schema changed — forward-only.
10. Write **e2e tests through HTTP**, covering success and every failure branch.
    Use port substitution only for infrastructure failures.
11. Run `pnpm lint && pnpm depcruise && pnpm test`. All three green, 100% coverage.
12. If the API surface changed, regenerate the client in `sebp-web` and commit it.
13. Self-review, open a PR, run `codex` review, address every finding.
14. Mark the task done in Pad with a comment saying what you verified.

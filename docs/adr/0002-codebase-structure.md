# ADR 0002 — Codebase structure and engineering rules

**Status:** Accepted · **Date:** 2026-08-20 · **Builds on:** [ADR 0001](./0001-tech-stack.md)
**Detail:** [codebase-structure.md](../codebase-structure.md)

---

## Context

Two repositories (`sebp-api`, `sebp-web`), strict ports and adapters, and an
intention to run several AI agents in parallel on separate git worktrees. The
structure has to serve three goals at once: keep the domain pure enough that the
D1→Postgres escape hatch stays real, keep the "nothing is hardcoded" constraint
enforceable, and let two agents work simultaneously without editing the same files.

## Decisions

### 1. Module-first, hexagonal within each module

`src/modules/<domain>/{domain,ports,use-cases,adapters,http}/` rather than
top-level layer folders.

The deciding factor was parallel work. Layer-first means every feature spans four
top-level directories, so two agents building different subsystems collide on every
one. Module-first gives each agent a single directory to own.

The cost is duplicated layer scaffolding across modules. Accepted.

### 2. Cross-module imports go through the module barrel only

A module's `index.ts` is its public surface: **domain types, port interfaces, and a
factory**. Everything else — adapters, routes, internal domain helpers — is private.
Module A may depend on module B's ports; it may never see B's adapters.

Enforced mechanically by `dependency-cruiser`, not by review discipline.

### 3. Strict domain purity

`domain/` imports no framework, no Cloudflare types, no Drizzle. Repositories return
domain entities, not database rows. Clock and ID generation are ports.

This is what makes the database swap designed for in ADR 0001 a genuine option
rather than a comforting sentence.

### 4. Composition root is the only place adapters are constructed

`container.ts` wires concrete adapters to ports. Nothing else calls `new` on an
adapter or reaches for a Cloudflare binding directly.

### 5. Contract by OpenAPI codegen

The API serves `/openapi.json`, generated from the same Zod schemas that validate
requests, so the spec cannot drift from the implementation. `sebp-web` runs
`openapi-typescript` in CI and commits the generated client. Closes open question
#8 from the technical design.

### 6. Failures are values, not exceptions

`Result<T, E>` through `domain/` and `use-cases/`, with error kinds as discriminated
unions owned by each module. `throw` is reserved for programmer error.

Chosen specifically because of decision 8: every error path must be reachable and
assertable from an HTTP test. Exceptions create catch blocks, and catch blocks are
the branches hardest to cover from outside.

### 7. Commands return entities; queries return read-model DTOs

Separate ports per side. Query ports project straight to view-shaped data in SQL and
never mutate. Hydrating an aggregate to render a list is the case this avoids, and it
matters most for dynamic-field filtering, which needs `json_extract` and generated
columns rather than domain objects.

### 8. Backend tests run through HTTP routes only, with a hard 100% coverage gate

No unit tests. Every backend test issues a real request against the Hono app with
real D1, R2, and KV bindings via `@cloudflare/vitest-pool-workers`. Coverage is
enforced at 100% and CI fails below it. `sebp-web` mirrors this with Playwright at
100%.

**One bounded exception: port substitution for failure paths.** No HTTP request can
make R2 presigning throw or a queue send fail, so those branches are unreachable
under a strict no-substitution reading — which made HTTP-only, no-mocks, and 100%
mutually unsatisfiable. Substituting an implementation of *our own port* that returns
an error resolves it without introducing third-party mocking. Substitution on a happy
path remains forbidden.

### 9. One vertical slice before fanning out

Prove a single module end to end — route, migration, adapters, container wiring,
OpenAPI entry, deployed, green at 100% — before building the other eight. The
coverage gate's real cost is unknown until it has been paid once.

### 10. better-auth is the sole exception to strict layering

It is not wrapped in a port, because it owns its schema and middleware. Its reach is
confined to `modules/identity` and `http/middleware/auth.ts`, enforced by
dependency-cruiser. Every other module sees a branded `UserId`.

## Consequences

**Good**

- One agent per module, minimal file collision — the parallel workflow works.
- The escape hatch is real: swapping D1 for Postgres touches adapters only.
- No happy-path mocking means no test that passes against a fake while production
  breaks.
- Every test exercises routing, middleware, auth, validation, and domain together.
- 100% coverage through HTTP has a useful side effect: **unreachable code cannot
  exist**. If a branch can't be hit by any request, it is dead and gets deleted.

**Costs and risks**

- **Slow feedback.** Every test boots a Workers runtime and touches a database.
  Combinatorial domain rules — transition gates, conditional field visibility,
  document expiry — are expensive to cover this way when they'd be microseconds as
  pure functions. CONVE-3 gates task completion on a green suite, so this cost is
  paid on every finished task.
- **Indirect failure diagnosis.** A broken invariant surfaces as a 422 with a
  message, not a failing assertion on the rule itself.
- **Defensive code becomes a liability.** A `throw new Error("unreachable")` guard is
  a branch no request can reach, so it blocks the gate. The correct response is to
  make invalid states unrepresentable in types rather than to litter the codebase
  with `/* v8 ignore */`. Ignore hints are permitted only where a genuine platform
  edge cannot be triggered, and each requires a comment explaining why.
- **Frontend coverage is fiddly.** Playwright does not produce coverage on its own;
  it needs Istanbul instrumentation of the built bundle plus a merge step.
- **The gate will slow early work.** 100% from the first commit means test
  infrastructure must exist before feature code does.

**Mitigations**

- Test fixtures and seed builders are first-class code, not an afterthought — they
  are what keeps HTTP-level tests writable.
- `vitest-pool-workers` isolated storage per test keeps tests parallel-safe.
- Domain functions stay pure anyway (decision 3), so if the testing strategy is ever
  revisited, unit tests can be added without restructuring.
- `Result` types (decision 6) make every failure an explicit branch rather than a
  catch block, which is what makes the gate reachable at all.
- Rules are enforced by `dependency-cruiser` and ESLint, not by review discipline —
  see [codebase-structure.md §14](../codebase-structure.md#14-enforcement).

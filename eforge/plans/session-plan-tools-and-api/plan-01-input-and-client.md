---
id: plan-01-input-and-client
name: Input session-plan helpers and client API surface
branch: session-plan-tools-and-api/input-and-client
---

## Architecture Context

This plan extends the existing `@eforge-build/input` session-plan library with the lifecycle, structured-mutation, and richer readiness helpers needed by daemon routes and integration tools, then exposes typed route constants and HTTP client helpers in `@eforge-build/client`. It is the foundation for plan-02 (daemon routes) and plan-03 (tools + skills) and must land before either of them.

Key existing surfaces:

- `packages/input/src/session-plan.ts` — current public API: `parseSessionPlan`, `serializeSessionPlan`, `listActiveSessionPlans`, `selectDimensions`, `checkReadiness`, `migrateBooleanDimensions`, `sessionPlanToBuildSource`, `normalizeBuildSource`. `SessionPlanStatus` is currently `'planning' | 'ready' | 'abandoned'`. Build skills already write `status: submitted` to enqueued session files, so existing files do not parse under the current schema — this plan fixes that.
- `packages/input/src/index.ts` — barrel re-export of session-plan and playbook surfaces.
- `packages/client/src/routes.ts` — `API_ROUTES` constant map plus request/response interfaces for the daemon HTTP API.
- `packages/client/src/api/playbook.ts` — reference implementation for a typed client surface (mirror its shape: per-route helper using `daemonRequest`, response/request interfaces co-located).
- `packages/client/src/api-version.ts` — `DAEMON_API_VERSION` constant; bump for any breaking change to route surface (adding new routes is additive, but plan-02 changes the implicit semantics of `POST /api/enqueue` to mutate session-plan frontmatter, which is a behavior change worth bumping for).

## Implementation

### Overview

1. Extend `SessionPlanStatus` and the Zod schema to include `submitted`, and adjust `listActiveSessionPlans` to continue excluding submitted plans (already does — only returns `planning` or `ready`; verify behavior is unchanged after schema change).
2. Add immutable mutation helpers in `packages/input/src/session-plan.ts` so the daemon and tool callers do not have to do YAML/Markdown surgery:
   - `createSessionPlan(opts)` — returns a fresh `SessionPlan` with canonical frontmatter for a new session.
   - `setSessionPlanSection(plan, dimensionName, content)` — append-or-replace a `## {Dimension Title}` section in the body, returning a new `SessionPlan`.
   - `skipDimension(plan, name, reason)` — add or update an entry in `skipped_dimensions`.
   - `unskipDimension(plan, name)` — remove an entry from `skipped_dimensions` (used when a previously skipped dimension is later filled in).
   - `setSessionPlanStatus(plan, status, metadata?)` — update `status` and optional fields like `eforge_session`. When status is `submitted`, requires `eforge_session` in metadata.
   - `setSessionPlanDimensions(plan, opts)` — apply `planning_type`, `planning_depth`, and write `required_dimensions`/`optional_dimensions` lists using the same internal `getDimensionsForType` rules. Should be a no-op when explicit lists are already present unless `overwrite: true` is passed.
   - Extend `checkReadiness` (or add `getReadinessDetail`) to also report `skippedDimensions` and `coveredDimensions` so callers can surface a complete readiness summary without re-parsing.
3. Resolve a session id to an absolute file path (`resolveSessionPlanPath(opts: { cwd, session })`) and read+parse it (`loadSessionPlan(opts)`), constraining resolution to `<cwd>/.eforge/session-plans/<session>.md` so daemon routes can defend against path traversal in plan-02.
4. Add `writeSessionPlan(opts: { cwd, session?, path?, plan })` that serializes a `SessionPlan` and writes it atomically to the resolved file path, also constrained to `.eforge/session-plans/`.
5. Re-export all new symbols and types from `packages/input/src/index.ts`.
6. Add session-plan route constants and request/response types in `packages/client/src/routes.ts` (under the existing `API_ROUTES` const) and a new file `packages/client/src/api/session-plan.ts` with typed helpers that call `daemonRequest`. Re-export from `packages/client/src/index.ts`.
7. Bump `DAEMON_API_VERSION` in `packages/client/src/api-version.ts` (current value 14 → 15) with a comment describing the addition of session-plan routes and the new auto-submit behavior at `POST /api/enqueue`.
8. Update `packages/input/README.md` to describe the new helpers and the `submitted` lifecycle status.

### Key Decisions

1. **Status enum extension over a separate `submittedAt` flag** — adding `submitted` to the same enum keeps a single source of truth for lifecycle and lets `listActiveSessionPlans` stay simple (filter to `planning|ready`). Existing `submitted` files will now parse instead of throwing.
2. **Helpers return new `SessionPlan` values, not write to disk** — keeps the in-memory contract consistent with `parseSessionPlan`/`serializeSessionPlan` and lets callers compose multiple updates before writing. `writeSessionPlan` is the single I/O entry point.
3. **Path resolution is constrained at the helper layer, not just at daemon edges** — `resolveSessionPlanPath` rejects anything outside `.eforge/session-plans/` so plan-02 can rely on input helpers as the trust boundary instead of re-implementing path checks.
4. **Route constants follow `API_ROUTES.sessionPlan*` naming** mirroring `playbook*` so the parity convention is preserved.
5. **`DAEMON_API_VERSION` bump** is required because plan-02 changes the post-enqueue behavior of an existing route (auto-marks session plans submitted). Treating that as a breaking change forces clients to upgrade in lockstep.

## Scope

### In Scope
- Extending `SessionPlanStatus` and `sessionPlanFrontmatterSchema` to accept `submitted`.
- Adding `createSessionPlan`, `setSessionPlanSection`, `skipDimension`, `unskipDimension`, `setSessionPlanStatus`, `setSessionPlanDimensions`, `loadSessionPlan`, `writeSessionPlan`, `resolveSessionPlanPath`, and an enriched readiness helper to `packages/input/src/session-plan.ts`.
- Re-exporting new symbols/types from `packages/input/src/index.ts`.
- Adding session-plan route constants and request/response types in `packages/client/src/routes.ts`.
- New file `packages/client/src/api/session-plan.ts` with typed helpers, exported via `packages/client/src/index.ts`.
- Bumping `DAEMON_API_VERSION` in `packages/client/src/api-version.ts`.
- Updating `packages/input/README.md` to document new helpers and `submitted` lifecycle.
- Tests for new input helpers in `test/session-plan.test.ts` (or a new `test/session-plan-helpers.test.ts`).

### Out of Scope
- Daemon HTTP route handlers — handled by plan-02.
- MCP / Pi tool registration and skill updates — handled by plan-03.
- Changes to engine code or `@eforge-build/scopes`.
- Changes to playbook code or schema.

## Files

### Create
- `packages/client/src/api/session-plan.ts` — typed client helpers (one function per route) and request/response interfaces, mirroring `packages/client/src/api/playbook.ts`.
- `test/session-plan-helpers.test.ts` (optional, may colocate in existing `test/session-plan.test.ts`) — tests for the new mutation helpers, status migration, and readiness detail.

### Modify
- `packages/input/src/session-plan.ts` — add `submitted` to `SessionPlanStatus` type and enum schema; add new mutation/load/write helpers; expand `checkReadiness` (or add a sibling) with skipped + covered details; export `resolveSessionPlanPath`.
- `packages/input/src/index.ts` — re-export new symbols (`createSessionPlan`, `setSessionPlanSection`, `skipDimension`, `unskipDimension`, `setSessionPlanStatus`, `setSessionPlanDimensions`, `loadSessionPlan`, `writeSessionPlan`, `resolveSessionPlanPath`) and types.
- `packages/input/README.md` — document the lifecycle including `submitted`, the new mutation helpers, and the path-constraint contract.
- `packages/client/src/routes.ts` — add `sessionPlanList`, `sessionPlanShow`, `sessionPlanCreate`, `sessionPlanSetSection`, `sessionPlanSkipDimension`, `sessionPlanSetStatus`, `sessionPlanSelectDimensions`, `sessionPlanReadiness`, `sessionPlanMigrateLegacy` entries to `API_ROUTES`. Add request/response interfaces for each.
- `packages/client/src/index.ts` — export the new helpers and types from `./api/session-plan.js`.
- `packages/client/src/api-version.ts` — bump `DAEMON_API_VERSION` from 14 to 15 with comment describing the change.
- `test/session-plan.test.ts` — extend coverage for the `submitted` status (parse, serialize round-trip, exclusion from `listActiveSessionPlans`).

## Verification

- [ ] `parseSessionPlan` accepts a session-plan file with `status: submitted` and round-trips through `serializeSessionPlan` byte-stable for that field.
- [ ] `listActiveSessionPlans` returns entries only for `planning` and `ready` statuses; `submitted` and `abandoned` plans are excluded.
- [ ] `setSessionPlanStatus(plan, 'submitted', { eforge_session: 'abc' })` returns a new `SessionPlan` with `status: 'submitted'` and `eforge_session: 'abc'` in the frontmatter; calling without `eforge_session` throws.
- [ ] `setSessionPlanSection(plan, 'scope', 'Add dark mode toggle')` produces a body that contains exactly one `## Scope` heading with the new content; calling again with different content replaces the section in place rather than duplicating it.
- [ ] `skipDimension(plan, 'documentation-impact', 'no docs affected')` adds an entry to `skipped_dimensions`; `unskipDimension(plan, 'documentation-impact')` removes it.
- [ ] `checkReadiness` (or `getReadinessDetail`) returns `coveredDimensions` and `skippedDimensions` arrays in addition to `missingDimensions` and the existing `ready` boolean.
- [ ] `resolveSessionPlanPath({ cwd, session: '../etc/passwd' })` throws (or returns an error result) instead of escaping `.eforge/session-plans/`.
- [ ] `writeSessionPlan` writes to `<cwd>/.eforge/session-plans/<session>.md` and refuses paths outside that directory.
- [ ] All session-plan-related symbols listed in plan body are exported from `packages/input/src/index.ts`.
- [ ] `API_ROUTES` contains the nine new session-plan route entries; `apiSessionPlanList`, `apiSessionPlanShow`, `apiSessionPlanCreate`, `apiSessionPlanSetSection`, `apiSessionPlanSkipDimension`, `apiSessionPlanSetStatus`, `apiSessionPlanSelectDimensions`, `apiSessionPlanReadiness`, and `apiSessionPlanMigrateLegacy` are exported from `@eforge-build/client`.
- [ ] `DAEMON_API_VERSION` equals 15 with a comment line explaining the session-plan additions and auto-submit behavior.
- [ ] `packages/input/README.md` lists `submitted` under lifecycle statuses and documents each new helper.
- [ ] `pnpm type-check` passes for `@eforge-build/input` and `@eforge-build/client`.
- [ ] `pnpm test` passes (existing `test/session-plan.test.ts` still green; new tests cover the additions).

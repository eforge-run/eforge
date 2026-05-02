---
id: plan-02-daemon-routes
name: Daemon session-plan HTTP routes and auto-submit on enqueue
branch: session-plan-tools-and-api/daemon-routes
---

## Architecture Context

This plan adds session-plan daemon HTTP routes in `packages/monitor/src/server.ts`, all backed by helpers from `@eforge-build/input` that landed in plan-01. It also updates the existing `POST /api/enqueue` route to mark a session plan `submitted` (with the spawned worker `sessionId`) when the accepted source resolves to a `.eforge/session-plans/*.md` path — moving that previously prompt-driven YAML edit into the input/control-plane boundary.

Key existing surfaces:

- `packages/monitor/src/server.ts` — the daemon HTTP router. Playbook routes (`playbookList`, `playbookShow`, `playbookSave`, `playbookEnqueue`, `playbookPromote`, `playbookDemote`, `playbookValidate`, `playbookCopy`) at lines ~1335–1690 are the canonical pattern to mirror for session-plan routes: dynamic-import `@eforge-build/input` inside each handler, validate input shape, surface 4xx vs 5xx based on error class, and use `sendJson` / `sendJsonError` from existing helpers.
- `POST /api/enqueue` lives at lines ~890–950 in the same file. It already calls `normalizeBuildSource` from `@eforge-build/input` for session-plan paths. The new behavior: after `workerTracker.spawnWorker('enqueue', args)` returns a `sessionId`, if the original source path was a session-plan file, load the plan, call `setSessionPlanStatus(plan, 'submitted', { eforge_session: result.sessionId })`, and `writeSessionPlan` it back. Failures here MUST NOT fail the enqueue — log and continue.
- `PLAYBOOK_NAME_RE` (line 1341) is the kebab-case validator used to defend against path traversal. Session ids follow the `YYYY-MM-DD-{slug}` shape; add a similar `SESSION_PLAN_ID_RE` validator.
- `DAEMON_API_VERSION` was bumped to 15 in plan-01.

## Implementation

### Overview

1. Add a `SESSION_PLAN_ID_RE` constant matching `^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*$` and use it for every route that accepts a `session` field. For routes that accept a `path`, validate that `resolveSessionPlanPath` accepts it (input helper from plan-01 throws on traversal).
2. Implement nine new routes mirroring playbook patterns. All read/write through `@eforge-build/input` helpers — no inline YAML/Markdown handling:
   - `GET /api/session-plan/list` → `listActiveSessionPlans({ cwd })` plus enriched readiness summary per entry (call `loadSessionPlan` then `getReadinessDetail` for each).
   - `GET /api/session-plan/show?session=<id>` → `loadSessionPlan` then return frontmatter, body, and readiness detail.
   - `POST /api/session-plan/create` → body `{ session, topic, planning_type?, planning_depth? }`. Calls `createSessionPlan` then `writeSessionPlan`. Returns `{ session, path }`.
   - `POST /api/session-plan/set-section` → body `{ session, dimension, content }`. Calls `loadSessionPlan` → `setSessionPlanSection` → `writeSessionPlan`. Returns updated readiness detail.
   - `POST /api/session-plan/skip-dimension` → body `{ session, dimension, reason }`. Calls `loadSessionPlan` → `skipDimension` → `writeSessionPlan`. Returns updated readiness detail.
   - `POST /api/session-plan/set-status` → body `{ session, status, eforge_session? }`. Calls `setSessionPlanStatus` → `writeSessionPlan`. `submitted` requires `eforge_session`; returns 400 otherwise.
   - `POST /api/session-plan/select-dimensions` → body `{ session, planning_type, planning_depth, overwrite? }`. Calls `setSessionPlanDimensions` → `writeSessionPlan`. Returns updated dimension lists + readiness detail.
   - `GET /api/session-plan/readiness?session=<id>` → returns readiness detail without mutating.
   - `POST /api/session-plan/migrate-legacy` → body `{ session }`. Calls `migrateBooleanDimensions` → `writeSessionPlan` if migration changed anything; returns whether the file was migrated.
3. Update `POST /api/enqueue` (lines ~890–950): after `spawnWorker` returns successfully and the source was a `.eforge/session-plans/<id>.md` path, load the plan, set status `submitted` with `eforge_session: <sessionId>`, and write back. Wrap in try/catch; on failure, log via `process.stderr.write` and continue — never fail the enqueue response.
4. Tests in a new `test/daemon-session-plan-routes.test.ts` covering each route's success path and the path-traversal rejection. Reuse the in-process daemon harness pattern from existing route tests (search for `cli-playbook.test.ts` / `daemon-recovery.test.ts` for setup). Add a test in the existing enqueue-route test that asserts the session-plan auto-submit behavior — including that an enqueue still succeeds when the post-write fails (e.g., simulated by removing the file between enqueue and write).

### Key Decisions

1. **Auto-submit is a daemon (control-plane) concern, not a tool concern** — the source PRD calls this out explicitly. Putting it in the enqueue route means every daemon caller (CLI, MCP tool, Pi tool, web UI) gets identical behavior with no client-side coordination.
2. **Auto-submit failures do not fail enqueue** — the build is already in flight by the time `writeSessionPlan` runs; failing the response would mislead callers. Log and continue.
3. **Routes accept `session` only, not `path`** — per the PRD's path-traversal note, prefer `session` for mutating actions. Internal use of `resolveSessionPlanPath` from plan-01 enforces the constraint.
4. **Path validation lives in the input helper** — the daemon route does input shape validation (regex + body schema) and lets `resolveSessionPlanPath` throw on traversal attempts, surfacing as 400.
5. **Readiness detail is returned by mutation routes** — `set-section`, `skip-dimension`, `select-dimensions` return updated readiness so callers (skills, MCP tool) can decide next steps without an extra GET.

## Scope

### In Scope
- Adding nine new daemon routes for session-plan operations to `packages/monitor/src/server.ts`.
- Updating `POST /api/enqueue` to call `setSessionPlanStatus` + `writeSessionPlan` for session-plan sources after worker spawn succeeds.
- Adding session-plan route handler tests under `test/`.
- Path-traversal validation through `resolveSessionPlanPath` plus regex check on `session` ids.

### Out of Scope
- MCP / Pi tool registration — plan-03.
- Skill updates — plan-03.
- Adding routes for full-file `save` (escape hatch deferred per PRD risk note).
- Engine changes.
- Web monitor UI for session plans.

## Files

### Create
- `test/daemon-session-plan-routes.test.ts` — covers success paths for each new route and path-traversal rejection.

### Modify
- `packages/monitor/src/server.ts` — add nine session-plan route handlers using the same dynamic-import + `sendJson` / `sendJsonError` pattern as the playbook block; add `SESSION_PLAN_ID_RE` constant; extend the existing `POST /api/enqueue` handler to mark session-plan sources `submitted` with the spawned `sessionId` after worker spawn succeeds (best-effort, log on failure).
- `test/normalize-build-source.test.ts` (or similar existing enqueue-flow test) — extend with a case asserting that enqueueing a `.eforge/session-plans/<id>.md` source mutates the file's frontmatter to `status: submitted` + `eforge_session: <sessionId>` post-spawn, and that an enqueue still succeeds when the post-write fails.

## Verification

- [ ] `GET /api/session-plan/list` returns active session plans in the project's `.eforge/session-plans/`, each entry including `session`, `topic`, `status`, `path`, and a readiness summary (`ready`, `missingDimensions`).
- [ ] `GET /api/session-plan/list` excludes plans with `status: submitted` or `status: abandoned`.
- [ ] `GET /api/session-plan/show?session=<id>` returns frontmatter, body, and readiness detail (`ready`, `missingDimensions`, `skippedDimensions`, `coveredDimensions`).
- [ ] `POST /api/session-plan/create` with `{ session, topic }` writes a new file at `<cwd>/.eforge/session-plans/<session>.md` with canonical frontmatter and returns `{ session, path }`.
- [ ] `POST /api/session-plan/set-section` with `{ session, dimension: 'scope', content: '...' }` updates the file's `## Scope` section in place and returns updated readiness detail.
- [ ] `POST /api/session-plan/skip-dimension` with `{ session, dimension, reason }` adds an entry to `skipped_dimensions` in the file.
- [ ] `POST /api/session-plan/set-status` with `{ session, status: 'submitted', eforge_session: 'abc' }` updates the file; calling with `status: 'submitted'` and no `eforge_session` returns 400.
- [ ] `POST /api/session-plan/select-dimensions` with `{ session, planning_type, planning_depth }` writes `required_dimensions`/`optional_dimensions` per the input helper's rules.
- [ ] `GET /api/session-plan/readiness?session=<id>` returns the same readiness detail shape as `show`, without mutating the file.
- [ ] `POST /api/session-plan/migrate-legacy` with a session id whose file uses the legacy boolean `dimensions: { ... }` shape rewrites the file using the new schema; for files already on the new schema, returns `{ migrated: false }` and does not rewrite.
- [ ] Any route called with `session: '../escape'` returns a 400 error (caught from `resolveSessionPlanPath`) and does not read or write outside `.eforge/session-plans/`.
- [ ] After `POST /api/enqueue` with a source path matching `.eforge/session-plans/<id>.md`, the file's frontmatter is updated to `status: submitted` and `eforge_session: <sessionId>`. The `/api/enqueue` response is unchanged.
- [ ] If the post-enqueue session-plan write fails (e.g., file removed between read and write), the enqueue route still returns a 200 response with the spawned `sessionId`.
- [ ] `pnpm type-check` passes.
- [ ] `pnpm test` passes.

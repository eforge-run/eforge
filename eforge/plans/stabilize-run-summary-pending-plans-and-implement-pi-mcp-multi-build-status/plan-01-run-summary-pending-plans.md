---
id: plan-01-run-summary-pending-plans
name: Re-apply RunSummary Pending Plans and planning:complete Seeding
branch: stabilize-run-summary-pending-plans-and-implement-pi-mcp-multi-build-status/plan-01-run-summary-pending-plans
---

# Re-apply RunSummary Pending Plans and planning:complete Seeding

## Architecture Context

The monitor daemon's `/api/run-summary/:id` endpoint currently derives the `plans` array exclusively from build lifecycle events (`plan:build:start`, `plan:build:complete`, `plan:build:failed`). Plans only appear in the summary once they have *started*, so consumers cannot show `0/2 plans` before any plan begins — the denominator equals the number of started plans, not the total generated plans. Plan-02 of this plan set (Pi/MCP multi-build footer) needs that denominator to include pending plans.

The prior PRD's plan-01 (commits `eb8d6629`, `a38ef0a3`, `40185ed3` on branch `eforge/improve-pi-eforge-footer-status-so-active-builds-and-plan-counts-are-accurate`) extracted the per-session summary derivation into an exported `buildRunSummary(db, sessionId)` helper, seeded the plan map from the latest `planning:complete` event with status `'pending'`, then overlaid the build lifecycle events. It also added `'pending'` to `RunSummary.plans[].status`, bumped `DAEMON_API_VERSION` from 28 → 29, and added a 223-line test file at `test/run-summary-plans.test.ts`. That plan failed, and significant unrelated work (`extension-management-surface-mvp`, `auto-build scheduler pause/resume`) has since landed on main — most of it touching the same `packages/monitor/src/server.ts` file (+216 insertions) and `packages/pi-eforge/extensions/eforge/index.ts` (+62 insertions).

This plan re-applies the equivalent diff onto the current main branch rather than attempting a literal `git rebase` of the stale feature branch. The shape of the re-applied changes is functionally identical to commits `a38ef0a3` and `40185ed3` plus the test file from `eb8d6629`; the only practical difference is that the surrounding `server.ts` now contains extension-management endpoints between the original handler block and the rest of the module.

Key seams on current `main`:
- `packages/monitor/src/server.ts` lines ~3148–3316 contain the inline `/api/run-summary/:id` handler that this plan extracts and rewrites.
- `packages/client/src/types.ts` line 212 declares the `RunSummary.plans[].status` union (currently `'running' | 'completed' | 'failed'`).
- `packages/client/src/api-version.ts` line 17 holds `DAEMON_API_VERSION = 28` with the per-version inline comment chain.
- `packages/monitor/package.json` uses an `./*` subpath export wildcard so `import { buildRunSummary } from '@eforge-build/monitor/server'` resolves through tsup's dist output once the function is exported.

## Implementation

### Overview

1. Extend the `RunSummary.plans[].status` discriminated union in `packages/client/src/types.ts` from `'running' | 'completed' | 'failed'` to `'pending' | 'running' | 'completed' | 'failed'`.
2. Bump `DAEMON_API_VERSION` to `29` in `packages/client/src/api-version.ts`; prepend a `v29: …` clause to the existing inline-comment chain that describes the `'pending'` addition and `planning:complete` seeding.
3. In `packages/monitor/src/server.ts`, extract the run-summary derivation into a new exported function `buildRunSummary(db: MonitorDB, sessionId: string): RunSummary`. Seed the plan map from the latest `planning:complete` event (status `'pending'`), then overlay `plan:build:start` (status `'running'`, capture branch and dependsOn when provided), `plan:build:complete` (status `'completed'`), and `plan:build:failed` (status `'failed'`). Fall back to build-event-only derivation when no `planning:complete` event is present. Replace the inline `RUN_SUMMARY_BASE` handler block with `sendJson(res, buildRunSummary(db, sessionId))`.
4. Add `test/run-summary-plans.test.ts` with five cases (mirrors the test file from commit `eb8d6629`): pending seeding from `planning:complete`, overlay→running while siblings stay pending, overlay→completed/failed with no dropped plans, fallback to build events when `planning:complete` is absent, and re-plan preference (latest `planning:complete` wins).
5. Update `test/daemon-recovery.test.ts`: the `it('is 28', …)` block becomes `it('is 29', …)` and the assertion changes from `expect(DAEMON_API_VERSION).toBe(28)` to `29`.

### Key Decisions

1. **Export `buildRunSummary` as a module-level function.** The new test file imports it directly via `@eforge-build/monitor/server`, which resolves through tsup's `./*` subpath export. Inlining the logic again in the HTTP handler would make the new test impossible without HTTP plumbing.
2. **Seed plans only from the *latest* `planning:complete` event**, not the union. Re-planning replaces the prior plan set; merging would carry stale plan ids forward and would not match engine intent. Verified by the `prefers latest planning:complete on re-plan` test case.
3. **Overlay-update existing seeded entries on `plan:build:start`** rather than replacing them: accept fresh `branch` and `dependsOn` when the start event provides them, preserve the seeded values when it does not. Falls back to inserting a fresh entry when the start event references an id that was not in `planning:complete` (backward-compatible path for sessions started before this wire change).
4. **Backward compatibility**: when no `planning:complete` event exists, the helper inserts fresh entries from build events with the exact shape today's handler produces. Existing API consumers see no regression.
5. **`DAEMON_API_VERSION` bump**: adding an enum variant to a public response field's union literal is a wire change. The version-line comment chain is preserved historically so prior version notes remain searchable.
6. **Strict type literal preserved inside the helper**: declare the local `planStatusMap` value type as `{ id: string; status: 'pending' | 'running' | 'completed' | 'failed'; branch: string | null; dependsOn: string[] }` to match the public `RunSummary.plans[]` element shape exactly. This is what surfaced the failure in the prior attempt — make the literal explicit at the map declaration site.

## Scope

### In Scope
- Adding `'pending'` to `RunSummary.plans[].status` in `packages/client/src/types.ts`.
- Bumping `DAEMON_API_VERSION` to 29 with a documenting `v29: …` clause prepended to the inline comment chain.
- Extracting `buildRunSummary` from the inline `/api/run-summary/:id` handler and routing the existing HTTP handler through it.
- Seeding plans from the latest `planning:complete` event with `pending` status.
- Overlaying `plan:build:start/complete/failed` onto seeded entries.
- Falling back to build-event-only derivation when `planning:complete` is absent.
- New unit test file at `test/run-summary-plans.test.ts`.
- Updating the `DAEMON_API_VERSION` assertion in `test/daemon-recovery.test.ts`.

### Out of Scope
- Pi extension footer or `eforge_status` rendering changes — handled in plan-02.
- MCP proxy `eforge_status` or `checkActiveBuilds` updates — handled in plan-02.
- New shared client helpers (`apiGetRunningRuns`, etc.) — handled in plan-02.
- Monitor UI changes — `packages/monitor-ui` does not consume `RunSummary` (it consumes the event stream directly; verified via grep).
- Documentation updates — no `docs/` or `web/content/` file describes the `RunSummary.plans[].status` union directly (verified via grep).

## Files

### Create
- `test/run-summary-plans.test.ts` — five-case unit test for `buildRunSummary`. Imports `openDatabase` from `@eforge-build/monitor/db`, `buildRunSummary` from `@eforge-build/monitor/server`, and `useTempDir` from `./test-tmpdir.js`. Each case opens an in-memory DB at `<tmp>/.eforge/monitor.db`, inserts a run via `db.insertRun({ … })`, inserts the relevant events via `db.insertEvent({ runId, type, planId?, data: JSON.stringify(payload), timestamp })`, then calls `buildRunSummary(db, sessionId)` and asserts on the resulting `summary.plans` array. Cases: (1) seeds pending plans from `planning:complete` (two plans, both `'pending'`, `branch` and `dependsOn` carried through); (2) overlays running on top of pending (one plan `'running'`, the other still `'pending'`); (3) overlays completed and failed with no plans dropped; (4) falls back to build events when `planning:complete` is absent (one `plan:build:start` produces one entry with status `'running'`); (5) prefers the latest `planning:complete` on re-plan (two planning events with different plan id sets; only the second's ids appear in `summary.plans`).

### Modify
- `packages/client/src/types.ts` — change the `RunSummary.plans[].status` literal union at line 212 from `'running' | 'completed' | 'failed'` to `'pending' | 'running' | 'completed' | 'failed'`. No other changes.
- `packages/client/src/api-version.ts` — change `DAEMON_API_VERSION` from `28` to `29`. Prepend a `// v29: adds 'pending' to RunSummary.plans[].status; /api/run-summary/:id now seeds plans from the latest planning:complete event before overlaying plan:build:start/complete/failed (falls back to build events when planning:complete is absent).` clause at the head of the existing inline comment chain on the same line; keep the entire prior v28→v23 history.
- `packages/monitor/src/server.ts` — extract a new `export function buildRunSummary(db: MonitorDB, sessionId: string): RunSummary { … }` near the top of the module body (after the `DaemonSSESubscriber` interface). The body: (a) computes session-level `status` from `db.getSessionRuns(sessionId)`; (b) builds the `runs` array; (c) declares `const planStatusMap = new Map<string, { id: string; status: 'pending' | 'running' | 'completed' | 'failed'; branch: string | null; dependsOn: string[] }>()`; (d) seeds the map from the *last* event in `db.getEventsByTypeForSession(sessionId, 'planning:complete')` when the JSON-parsed `data.plans` is an array, setting `status: 'pending'`, `branch: planFile.branch ?? null`, `dependsOn: planFile.dependsOn ?? []`; (e) iterates `plan:build:start` events: when `planStatusMap.has(data.planId)` update the existing entry's `status` to `'running'` (and overwrite `branch`/`dependsOn` when the event provides them); otherwise insert a fresh entry with `status: 'running'`; (f) iterates `plan:build:complete` events updating `status` to `'completed'` on existing entries; (g) iterates `plan:build:failed` events updating `status` to `'failed'` on existing entries; (h) computes `currentPhase`, `currentAgent`, `eventCounts`, and `duration` identically to today's inline handler; (i) returns a `RunSummary` whose `plans` is `Array.from(planStatusMap.values())`. Then replace the inline `RUN_SUMMARY_BASE` handler block (currently the `getEventsByTypeForSession` loops and `Array.from(planStatusMap.values())` construction around lines 3148–3316) with a single `sendJson(res, buildRunSummary(db, sessionId))` call after the existing id validation and `resolveSessionId(id)` lookup. Import `RunSummary` from `@eforge-build/client` if not already in scope at the module top.
- `test/daemon-recovery.test.ts` — change the `it('is 28', () => { expect(DAEMON_API_VERSION).toBe(28); })` block (line ~128) so the label reads `'is 29'` and the assertion reads `.toBe(29)`.

## Verification

- [ ] `buildRunSummary` is exported from `packages/monitor/src/server.ts` and is importable in the new test as `import { buildRunSummary } from '@eforge-build/monitor/server'`.
- [ ] `RunSummary.plans[].status` in `packages/client/src/types.ts` is the literal union `'pending' | 'running' | 'completed' | 'failed'`.
- [ ] `DAEMON_API_VERSION` equals `29` in `packages/client/src/api-version.ts` and the trailing inline comment begins with `v29:` and mentions both `'pending'` and `planning:complete` seeding.
- [ ] Given a session DB with one `planning:complete` event listing two plans and zero build events, `buildRunSummary(db, sessionId).plans` has length 2 and every entry has `status === 'pending'` (`test/run-summary-plans.test.ts` case 1).
- [ ] Given the same session DB plus one `plan:build:start` for one of the two plans, `buildRunSummary(db, sessionId).plans` has length 2 with statuses `['running', 'pending']` in plan-id order (case 2).
- [ ] Given a session DB with `planning:complete` plus `plan:build:start` for both plans, `plan:build:complete` for the first, and `plan:build:failed` for the second, `buildRunSummary(db, sessionId).plans` has length 2 with statuses `['completed', 'failed']`; no plan is dropped (case 3).
- [ ] Given a session DB with no `planning:complete` event and one `plan:build:start` event carrying `{ planId, branch, dependsOn }`, `buildRunSummary(db, sessionId).plans` has length 1 with `id`, `status: 'running'`, `branch`, and `dependsOn` matching the event payload (case 4 — backward compatibility).
- [ ] Given a session DB with two `planning:complete` events listing different plan id sets, `buildRunSummary(db, sessionId).plans` reflects only the latest event's plan ids; ids from the earlier event are absent (case 5).
- [ ] `pnpm type-check` exits 0.
- [ ] `pnpm test` exits 0; all five new cases in `test/run-summary-plans.test.ts` pass; the `daemon-recovery.test.ts` `DAEMON_API_VERSION` case passes against `29`.

---
title: Stabilize Run-Summary Pending Plans and Implement Pi/MCP Multi-Build Status
created: 2026-05-15
---

# Stabilize Run-Summary Pending Plans and Implement Pi/MCP Multi-Build Status

## Overview

This is the successor build to a partially completed session. Plan-01 of the original PRD implemented the `pending` plan status in `RunSummary` and refactored `/api/run-summary/:id` to seed plans from `planning:complete`, but the plan was marked failed (likely due to a type-check or test failure that was not fully resolved). Plan-02 (Pi/MCP multi-build status) never ran because it was blocked by plan-01's failure.

This successor PRD covers two phases:
1. **Stabilize** plan-01's landed work on the feature branch — diagnose and fix any remaining type or test failures.
2. **Implement** the full plan-02 scope — multi-build awareness in the Pi footer, `eforge_status`, stop safety, and MCP parity.

## Starting Point

The following is already implemented on branch `eforge/improve-pi-eforge-footer-status-so-active-builds-and-plan-counts-are-accurate`:

- `packages/client/src/types.ts`: `RunSummary.plans[].status` extended to include `'pending'`
- `packages/client/src/api-version.ts`: `DAEMON_API_VERSION` bumped to document the wire change
- `packages/monitor/src/server.ts`: `/api/run-summary/:id` refactored to seed its plan map from the latest `planning:complete` event, then overlay `plan:build:start` → `running`, `plan:build:complete` → `completed`, `plan:build:failed` → `failed`; falls back to build-event-only derivation when no `planning:complete` is present
- `test/run-summary-plans.test.ts`: 223-line new test file covering plan-seeding and overlay semantics; a follow-on "fix test issues" commit was applied but plan-01 still ended in a failed state

**First action required:** Run `pnpm type-check` and `pnpm test` on the feature branch to identify whether any failures remain from plan-01's work. Fix all failures before proceeding to the Pi/MCP implementation.

## Phase 1 — Stabilize Plan-01 Work

Verify `pnpm type-check` and `pnpm test` pass on the feature branch as-is. Fix any remaining failures in:
- `packages/monitor/src/server.ts` (run-summary plan seeding logic)
- `test/run-summary-plans.test.ts` (plan-seeding and overlay assertions)
- Any downstream type errors caused by adding `'pending'` to `RunSummary.plans[].status`

## Phase 2 — Pi/MCP Multi-Build Status (Plan-02 Scope)

### Pi Extension (`packages/pi-eforge/extensions/eforge/index.ts`)

- Replace or complement `getPreferredRun()` with a helper that returns **all running sessions** (entries from `/api/runs` with `status === 'running'` and a `sessionId`, deduped by `sessionId`).
- Update the footer polling loop to fetch a `RunSummary` for each running session.
- **Single active build**: preserve the current detailed footer style. Numerator and denominator should now use generated-plan counts from the `pending`-aware `RunSummary`.
- **Multiple active builds**: render an aggregate footer that makes concurrency explicit, for example: `eforge builds: 2 running - 0/4 plans - 2 active - 13m`. Numerator = completed plans across all summaries; denominator = all plans (pending + running + completed + failed) across all summaries; `active` = plans currently `running`; duration = elapsed time since the oldest active build started. Document the duration convention in code.
- Update `formatQueueFooter(queueItems, hasRunningBuild)` so `hasRunningBuild` is `true` when any running session exists.
- Update `eforge_status` rendering to show **all** active running builds (not only one preferred/latest). Render each build's session/title/command, status, plan progress (`N/M plans`), current activity if available, and errors if any.
- Update `checkActiveBuilds()` to detect any running build. If multiple sessions are active, report the count, e.g. `2 eforge builds are currently active. Use force: true to stop anyway.`

### Shared Client Helpers (`packages/client/src/api/queue.ts`)

- Add shared helpers such as `apiGetRunningRuns()` and/or `apiGetRunningSessionSummaries(cwd?)` to avoid duplicating run-filtering logic across the Pi extension and MCP proxy. These should filter `/api/runs` by `status === 'running'` and `sessionId` present, deduped by `sessionId`.

### MCP Proxy (`packages/eforge/src/cli/mcp-proxy.ts`)

- Update `eforge_status` to expose all concurrent active builds. Currently it calls `apiGetLatestRunFromRuns()` and returns a single summary; update it to call the new shared helper and return all running summaries.
- If a fully dynamic multi-summary response shape is not feasible for the MCP JSON surface, document the reason clearly and provide the best available approximation (e.g. include a `builds` array alongside the existing top-level fields).

### Test Coverage

- Extract any multi-build aggregation logic and footer formatting into pure helper functions so they can be unit-tested without registering an extension.
- Add unit tests for: multi-build aggregation (plan count numerator/denominator/active), aggregate footer formatting (single-build vs multi-build), `checkActiveBuilds()` multi-session detection.
- There are no existing tests for `packages/pi-eforge`; extracted pure helpers are the target for new coverage.

## Acceptance Criteria

### Run-Summary Plan Counts (Phase 1 stabilization — must pass before Phase 2)

1. Given a session with a `planning:complete` event containing two plans and no `plan:build:start` events, `/api/run-summary/:id` returns both plans with `status: 'pending'`.
2. Given one of those plans has emitted `plan:build:start`, the summary returns two plans: one `running`, one `pending`.
3. Given lifecycle completion/failure events, the matching plan statuses become `completed` or `failed` without dropping other generated plans.
4. If no `planning:complete` event is available, run-summary continues to derive visible plans from build events (backward compatibility).
5. `pnpm type-check` passes with the `'pending'` addition to `RunSummary.plans[].status`.

### Pi Footer (Phase 2)

6. With exactly one running build, the footer remains detailed and shows completed-over-total generated plans, e.g. `0/2 plans` before any plan completes (denominator reflects generated plans, not only started plans).
7. With multiple running builds, the footer makes concurrency explicit — includes `N running` and an aggregate plan count such as `0/4 plans`.
8. The aggregate footer does not silently select one build when more than one is running.
9. Queue footer still shows pending/waiting non-running queue work and does not misleadingly duplicate running builds.

### `eforge_status`

10. Explicit status checks reveal all active running builds rather than only one preferred/latest build.
11. The rendered Pi status view shows each active build at least by session/title/command, status, plan progress, current activity if available, and errors if any.
12. The MCP/Claude-facing `eforge_status` is updated consistently or a documented reason is provided if full parity is not feasible.

### Stop Safety

13. Daemon stop without `force` is blocked if any build is running, including when the newest/preferred run is not the only active one.
14. The blocked-stop message reports the count of active builds when more than one session is running.

### Validation

15. `pnpm type-check` passes.
16. `pnpm test` passes, including new/updated tests for run-summary pending plans and multi-build aggregation/formatting behavior.
17. `DAEMON_API_VERSION` bump comment documents the `RunSummary.plans[].status = 'pending'` addition.

## Out of Scope

- Implementing the `RunSummary` pending-plan wire change (already done in plan-01 commits on the feature branch).
- Changing monitor UI behavior unless required by the shared wire type change.
- Changing queue scheduling semantics or allowing build cancellation/reordering.
- Adding a new daemon endpoint — use existing `/api/runs` + `/api/run-summary/:id`.
- Reworking event schemas beyond the minimal `pending` status addition already landed.

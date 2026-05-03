---
title: Monitor UI technical debt cleanup: remove dead code, reduce casts, and move wire protocol types toward @eforge-build/client
created: 2026-05-03
---

# Monitor UI technical debt cleanup: remove dead code, reduce casts, and move wire protocol types toward @eforge-build/client

## Problem / Motivation

The monitor UI has accumulated technical debt that violates project conventions and complicates browser/UI maintenance:

- `packages/monitor-ui/src/lib/types.ts` re-exports `EforgeEvent` and related event types from `@eforge-build/engine/events`, creating a browser/UI dependency on engine internals.
- `packages/monitor-ui/package.json` and `tsconfig.json` include `@eforge-build/engine` dependencies/path aliases because of those event type imports.
- `pnpm --filter @eforge-build/monitor-ui build` passes, but Vite warns that importing the broad `@eforge-build/client` entrypoint externalizes Node modules (`fs`, `path`, `crypto`, `http`, `child_process`) for browser compatibility. A browser-safe client subpath would help.
- `rg` shows casts in `src/lib/reducer/` handler files, `src/components/timeline/event-card.tsx`, `src/components/pipeline/thread-pipeline.tsx`, `src/components/layout/queue-section.tsx`, and graph node/edge adapters.
- Several exported API helpers in `src/lib/api.ts` appear unused: `fetchRuns`, `fetchLatestRunId`, `fetchQueue`, `fetchPlanDiffs`.
- `src/lib/plan-content.ts` manually parses YAML and returns `migrations` but never populates it, despite the UI displaying migrations.

Project conventions from `AGENTS.md` say monitor UI should use shadcn/ui components, daemon/client HTTP route contract should flow through `@eforge-build/client`, and route literals should not be inlined. The roadmap specifically calls out "Typed SSE events in client package" and broader client/shared registry work, which aligns with moving monitor UI off direct `@eforge-build/engine/events` imports.

Validation baseline already checked:
- `pnpm --filter @eforge-build/monitor-ui type-check` passes.
- Targeted monitor UI tests pass.
- `pnpm --filter @eforge-build/monitor-ui build` passes with bundle warnings noted above.

Note: The reducer decomposition into `packages/monitor-ui/src/lib/reducer/` (handler files) and the `thread-pipeline.tsx` refactor into multiple pipeline component files have already been completed. This PRD operates on that already-refactored codebase.

## Goal

Move monitor UI wire-protocol type ownership to `@eforge-build/client`, drop the direct engine dependency from monitor UI, and clean up confirmed dead code, localized casts, and YAML frontmatter parsing.

## Approach

Refactor-focused monitor UI package-boundary and dead-code cleanup.

**Profile signal:** Recommended profile **errand**. Rationale: this is a bounded package-boundary/dead-code cleanup. It touches multiple packages (`client`, `engine`, `monitor-ui`) but is mostly mechanical type/export/import work plus small localized cleanup.

**Code impact** (primary packages/files affected):

Client package:
- `packages/client/src/events.ts` (preferred) or `packages/client/src/types.ts`: add pure TypeScript wire event types used by SSE/run-state consumers. These types must be browser-safe: no Node-only imports and no imports from `@eforge-build/engine`.
- `packages/client/src/index.ts`: export the event wire types if the root entrypoint remains browser-safe enough for type-only monitor imports.
- Prefer adding a browser-safe subpath such as `@eforge-build/client/browser` if needed to let monitor UI import `API_ROUTES`, `buildPath`, `subscribeToSession`, route response types, and event wire types without pulling Node-only daemon/lockfile helpers into the browser bundle.
- `packages/client/package.json`: add export metadata for the browser-safe subpath if implemented.

Engine package:
- Keep engine as event producer; do not change runtime event payload shapes.
- If shared type ownership is moved, update `packages/engine/src/events.ts` carefully so existing engine exports keep working for engine-internal callers.

Monitor UI:
- `packages/monitor-ui/src/lib/types.ts`: switch event-related exports (`EforgeEvent`, `AgentRole`, `AgentResultData`, `EforgeResult`, `ClarificationQuestion`, `ReviewIssue`, `PlanFile`, `OrchestrationConfig`, `PlanState`, `EforgeState`, `ExpeditionModule`) from engine-owned imports to client-owned wire types where feasible. Keep UI-only types local.
- `packages/monitor-ui/package.json`: remove `@eforge-build/engine` when no longer needed.
- `packages/monitor-ui/tsconfig.json`: remove `@eforge-build/engine/*` path alias when no longer needed.
- `packages/monitor-ui/src/lib/api.ts`: remove unused exports and align local response shapes with existing shared client response types where simple.
- `packages/monitor-ui/src/lib/plan-content.ts`: replace hand-written YAML frontmatter parsing with `yaml` parsing (the `yaml` package is already in monitor-ui's package.json) and populate migrations correctly.
- `packages/monitor-ui/src/components/layout/queue-section.tsx` and `packages/monitor-ui/src/components/recovery/sidecar-sheet.tsx`: replace recovery sidecar verdict casts with shared client types or small local validators.
- Adjust import paths in `packages/monitor-ui/src/lib/reducer/` handler files and the refactored pipeline components (e.g., `plan-row.tsx`, `stage-overview.tsx`, `activity-overlay.tsx`) as required by the client type move - but avoid behavioral changes to those files.

Tests/guards:
- Update `test/monitor-plan-preview.test.ts` for YAML/migration parsing.
- Keep `packages/monitor-ui/src/__tests__/api-routes-compliance.test.tsx` passing.
- Add a guard test or compliance assertion that monitor UI source no longer imports `@eforge-build/engine/events` or uses the `@eforge-build/engine/*` path alias.
- Run monitor UI type-check, targeted monitor tests, and production build.

## Scope

**In scope:**
- Move monitor UI wire-protocol type ownership toward `@eforge-build/client`: add/export browser-safe event wire types from the client package and switch monitor UI imports away from `@eforge-build/engine/events`.
- Remove `@eforge-build/engine` as a direct monitor UI dependency/path alias once event types are available from client.
- Remove dead/unused monitor UI code, especially unused API helpers in `packages/monitor-ui/src/lib/api.ts` (`fetchRuns`, `fetchLatestRunId`, `fetchQueue`, `fetchPlanDiffs`) if confirmed unused.
- Replace small, localized casts outside the reducer/pipeline behavior, especially recovery sidecar verdict casts and API/local response types where shared client types already exist or can be added cleanly.
- Import-path adjustments in `reducer/` handler files and refactored pipeline component files as required by the type ownership move.
- Improve plan frontmatter parsing in `packages/monitor-ui/src/lib/plan-content.ts` using the existing `yaml` dependency so displayed metadata such as migrations is correct.
- Add lightweight guard/tests that prevent monitor UI from regressing to engine-owned event type imports.

**Out of scope:**
- Behavioral changes to the reducer handler files or pipeline components beyond import-path adjustments.
- Queue reordering/priority editing UI.
- New monitor screens such as playbook/session-plan/profile management.
- Large styling/layout redesign.
- Changing daemon event payload shapes unless strictly required to type existing wire events.

## Acceptance Criteria

1. **Wire protocol type ownership**
   - Monitor UI no longer imports event wire types from `@eforge-build/engine/events`.
   - `packages/monitor-ui/package.json` no longer includes `@eforge-build/engine` solely for monitor UI type imports.
   - `packages/monitor-ui/tsconfig.json` no longer includes the `@eforge-build/engine/*` path alias.
   - `@eforge-build/client` exposes the event wire types needed by monitor UI through a browser-safe type surface.
   - A test or compliance check prevents monitor UI from reintroducing direct engine event imports.

2. **Browser-safe client usage**
   - Monitor UI imports only browser-safe client route/stream/type exports.
   - `pnpm --filter @eforge-build/monitor-ui build` no longer warns that the monitor UI browser bundle externalizes Node-only modules because of the broad client entrypoint, or the implementation documents a precise deferred follow-up if a browser subpath cannot be completed safely in this PRD.

3. **Dead code cleanup**
   - Confirmed-unused monitor UI API helpers (`fetchRuns`, `fetchLatestRunId`, `fetchQueue`, `fetchPlanDiffs`) are removed, or any retained helper has an active caller/test and a clear purpose.

4. **Localized cast/type cleanup**
   - Recovery sidecar verdict casts in queue/recovery components are replaced by shared client types or small validators.
   - Remaining `as unknown as ...` casts in reducer handler files and pipeline components are left unchanged unless the import-path migration mechanically requires type adjustments.

5. **Frontmatter correctness**
   - `parseFrontmatterFields` uses real YAML parsing (the `yaml` library already in package.json) or equivalent robust parsing.
   - Migrations in plan frontmatter are populated correctly when present.
   - Existing plan preview/frontmatter tests cover dependencies, branch, and migrations.

6. **Validation**
   - `pnpm --filter @eforge-build/monitor-ui type-check` passes.
   - Targeted monitor UI tests pass, including plan preview/frontmatter tests, recovery UI tests, API route compliance, and the new engine-import guard.
   - `pnpm --filter @eforge-build/monitor-ui build` passes.
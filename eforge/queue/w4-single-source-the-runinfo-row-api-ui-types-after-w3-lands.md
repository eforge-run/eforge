---
title: W4 — Single-source the RunInfo row/API/UI types after W3 lands
created: 2026-05-06
depends_on: ["replace-daemon-resync-marker-and-on-connect-heartbeat-with-a-designed-in-stream-hello-sse-handshake-primitive"]
---

# W4 — Single-source the RunInfo row/API/UI types after W3 lands

## Problem / Motivation

Daemon wire shapes for runs, queue items, session metadata, and auto-build state are duplicated and projected in multiple places, causing schema drift across the daemon HTTP/SSE boundary:

- `packages/client/src/types.ts` owns `RunInfo`, `QueueItem`, `SessionMetadata`, and `AutoBuildState` as API response types.
- `packages/monitor/src/db.ts` still declares `RunRecord`, returns it from all run read paths, and relies on inline SQL aliases such as `session_id as sessionId`, `plan_set as planSet`, `started_at as startedAt`, `completed_at as completedAt`.
- `packages/monitor/src/server.ts` serves `/api/runs` directly from `db.getRuns()`, builds queue items via an inline local `QueueItem` type in `serveQueue`, returns session metadata from `db.getSessionMetadataBatch()`, and returns auto-build state inline from daemon state.
- `packages/monitor-ui/src/lib/types.ts` duplicates `QueueItem`, `RunInfo`, and `SessionMetadata` instead of re-exporting those shared wire types from `@eforge-build/client/browser`.
- `packages/client/src/event-registry.ts` already projects daemon-wide events into `RunInfo` and `QueueItem`, so this work must preserve compatibility with the registry-driven daemon reducer.
- If W3 has landed, `serveDaemonEventsSSE` should include a `stream:hello` snapshot containing `runs`, `queue`, `sessionMetadata`, and `autoBuild`; W4 must ensure those fields are constructed through the same canonical projection functions as the REST endpoints.

This is a **refactor / focused** change: it removes duplicate type and projection definitions without intending to change runtime behavior. W3 is the upstream build that will add `stream:hello` snapshot envelopes; W4 should start only after W3 merges so the snapshot constructor can be included in the single-source sweep.

Roadmap alignment: this supports the roadmap's Integration & Maturity theme by reducing schema drift in the daemon HTTP/SSE boundary. It is not itself the broader TypeBox schema-library unification item.

Project conventions relevant to this work:
- HTTP route contracts and response types belong in `@eforge-build/client`; daemon/server/UI should import shared route helpers and shared types rather than duplicate them.
- Event schemas are already centralized in `packages/client/src/events.schemas.ts`; this plan should not broaden into event-row schema unification.
- `DAEMON_API_VERSION` is bumped only for HTTP/SSE surface changes. If W4 only changes implementation mappings without changing public shapes, no bump is needed; if W3's snapshot shape is adjusted, bump accordingly.
- Tests use real code rather than mocks; file searches should exclude `node_modules/` and `dist/`.

## Goal

Make `@eforge-build/client` the single source of truth for the `RunInfo`, `QueueItem`, `SessionMetadata`, and `AutoBuildState` wire shapes, with daemon DB/server and monitor UI consuming those shared types via named projection helpers so REST endpoints and the W3 `stream:hello` snapshot produce identical wire shapes with no parallel object-shaping code.

## Approach

### Profile Signal

Recommended profile: **Excursion**.

Rationale: W4 is a bounded multi-file refactor across the client type package, monitor DB/server, monitor UI type re-exports, and tests. It has cross-package type-safety requirements and W3 snapshot parity checks, but it does not require expedition-level decomposition because the work is one cohesive boundary cleanup with no independent subsystems.

### Primary files

- `packages/client/src/types.ts`
  - Remains canonical for `RunInfo`, `QueueItem`, `SessionMetadata`, and `AutoBuildState`.
  - Prefer no public shape changes. If adding helper-only row types, keep them daemon-private rather than exporting DB internals from the client package.

- `packages/monitor/src/db.ts`
  - Import `RunInfo` from `@eforge-build/client`.
  - Delete `RunRecord`.
  - Add a private `RunRow` type matching the SQLite column names (`session_id`, `plan_set`, `started_at`, `completed_at`) and a `rowToRunInfo(row: RunRow): RunInfo` helper.
  - The helper must construct a full `RunInfo` object explicitly so adding a required `RunInfo` field fails `pnpm type-check` when the mapping is not updated.
  - Change run SELECT statements to select plain DB column names for the run fields, e.g. `SELECT id, session_id, plan_set, command, status, started_at, completed_at, cwd, pid ...`.
  - Apply `rowToRunInfo` in every run read path: `getRuns`, `getRunningRuns`, `getRun`, `getRunsBySession`, and `getSessionRuns`.
  - Keep event/file-diff aliases out of scope unless they feed one of the W3 snapshot wire fields.

- `packages/monitor/src/server.ts`
  - `serveRuns` should keep returning `RunInfo[]`, but from DB methods that now already return `RunInfo[]`.
  - `serveQueue` currently declares a local `QueueItem`; replace that with the shared type and/or a named helper such as `queueFileToQueueItem(...)` / `loadQueueItems(...)` returning `QueueItem[]`.
  - Add named projection helpers for `autoBuildStateToWire(options.daemonState): AutoBuildState` and for session metadata if needed, so REST and W3 snapshot paths do not hand-build divergent objects.
  - Once W3 has landed, update the `stream:hello` daemon snapshot construction to call the same helpers as `/api/runs`, `/api/queue`, `/api/session-metadata`, and `/api/auto-build`.

- `packages/monitor-ui/src/lib/types.ts`
  - Remove duplicate local `QueueItem`, `RunInfo`, and `SessionMetadata` interfaces.
  - Re-export/import those names from `@eforge-build/client/browser` so existing UI imports from `@/lib/types` continue to work while the source of truth is the client package.
  - Check whether `pid?: number` was missing from the UI duplicate `RunInfo`; after re-export, UI gets the canonical shape.

- `packages/client/src/event-registry.ts`
  - Ensure project functions that create or update `RunInfo` / `QueueItem` still compile against the canonical types.
  - If a helper is appropriate for constructing a run from lifecycle events, avoid duplicating `RunInfo` shape there too; keep event-derived projection explicit and typed.

- `packages/monitor-ui/src/lib/daemon-reducer.ts`, `packages/monitor-ui/src/hooks/use-daemon-events.ts`, and W3-updated snapshot hook code
  - Should compile with the re-exported canonical types and consume the W3 `stream:hello` snapshot without local type drift.

- `AGENTS.md`
  - Add a convention: DB rows may be snake_case internally, but HTTP/SSE wire shapes are owned by `@eforge-build/client`; daemon read/projection paths must use named mapping helpers rather than inline SQL aliases or duplicate local interface definitions.

### Tests and verification files

- Add or update monitor tests for run round-trip behavior. Existing test location may be `packages/monitor/src/__tests__/` rather than `packages/monitor/test/`; use the existing package convention.
- Add/extend a W3 `stream:hello` SSE test to assert the daemon snapshot's `runs`, `queue`, `sessionMetadata`, and `autoBuild` are deep-equal to what the REST endpoints return for the same seeded daemon state.
- Add grep-style regression tests only where the project already uses them; otherwise document grep verification in the PRD/build output.

### Commands

- `pnpm type-check`
- `pnpm test`
- Targeted vitest packages if available for monitor/client/monitor-ui tests.

### Sequencing note

This plan assumes W3 has merged. If W3 is not yet on the branch at build time, stop and either requeue after W3 or implement only the REST/DB/UI half while preserving the W3 conditional AC for a follow-up; the preferred path is to wait for W3 so the snapshot helper wiring is included in one pass.

## Scope

### In scope

- Make `packages/client/src/types.ts` the canonical owner for the daemon wire shapes used by the runs/queue/session-metadata/auto-build surfaces:
  - `RunInfo`
  - `QueueItem`
  - `SessionMetadata`
  - `AutoBuildState`
- Delete `RunRecord` from `packages/monitor/src/db.ts`; monitor DB read methods that expose runs should return `RunInfo`.
- Replace run-table inline SQL camelCase aliases in `db.ts` with plain snake_case column selection plus one typed `rowToRunInfo` mapping function.
- Make `rowToRunInfo` the only snake_case DB-row → `RunInfo` transformation for run reads (`getRuns`, `getRunningRuns`, `getRun`, `getRunsBySession`, `getSessionRuns`).
- Remove duplicate monitor UI definitions for shared wire shapes in `packages/monitor-ui/src/lib/types.ts`; re-export/import `RunInfo`, `QueueItem`, and `SessionMetadata` from `@eforge-build/client/browser` instead.
- Replace the local inline `QueueItem` type and queue item shaping in `serveQueue` with a canonical projection helper that returns the shared client `QueueItem` type.
- Ensure `SessionMetadata` and `AutoBuildState` responses are shaped by named projection/helpers rather than ad-hoc object literals in separate call sites.
- After W3 lands, ensure the daemon-events `stream:hello` snapshot and the REST endpoints share those same helpers for `runs`, `queue`, `sessionMetadata`, and `autoBuild`.
- Add tests proving REST and W3 SSE snapshot bootstrap produce the same wire shapes.
- Add a short convention note to `AGENTS.md` documenting that run/queue/session/auto-build wire shapes are owned by `@eforge-build/client` and daemon code should use explicit projection helpers rather than inline aliases or local duplicate types.

### Out of scope

- Do not redesign or migrate the SQLite `runs` schema; existing `monitor.db` files must keep loading.
- Do not single-source event-row shapes (`EventRecord`, `parseEventRow`, event table aliases); that belongs to the event/Zod spine work, not W4.
- Do not change the public `RunInfo`, `QueueItem`, `SessionMetadata`, or `AutoBuildState` JSON shapes unless a real bug is found. If a shape does change, explicitly bump `DAEMON_API_VERSION` and document why.
- Do not rework queue scheduling, recovery sidecars, auto-build behavior, or session metadata semantics.
- Do not adopt TypeBox/Zod for these non-event API shapes in this PRD; keep the implementation to TypeScript types plus explicit projection functions unless W3 introduced already-existing schema helpers that should be reused.

## Acceptance Criteria

1. `RunRecord` is deleted from `packages/monitor/src/db.ts`; all run read APIs in the monitor DB return the shared `RunInfo` type from `@eforge-build/client`.
2. `db.ts` has exactly one DB-row → run-wire mapping helper, `rowToRunInfo` (or an equivalently named function), and every run read path uses it.
3. Run SELECT queries in `db.ts` no longer use inline camelCase aliases for `RunInfo` fields. Grep in `packages/monitor/src/db.ts` for `as sessionId`, `as planSet`, `as startedAt`, and `as completedAt` returns zero hits for run queries.
4. Adding a new required field to `RunInfo` and omitting it from `rowToRunInfo` fails `pnpm type-check` because the helper explicitly returns `RunInfo`.
5. Existing `monitor.db` files continue to load: no SQLite migration or column rename is required for this PRD.
6. `packages/monitor-ui/src/lib/types.ts` no longer locally defines duplicate `RunInfo`, `QueueItem`, or `SessionMetadata` interfaces; those names resolve to `@eforge-build/client/browser` exports while preserving existing `@/lib/types` import sites.
7. `serveQueue` uses the shared `QueueItem` type and a named projection/loading helper; there is no local inline `type QueueItem = ...` inside `packages/monitor/src/server.ts`.
8. `AutoBuildState` responses are built through one named helper used by every auto-build read path. If W3's `stream:hello` snapshot includes `autoBuild`, it uses the same helper as `/api/auto-build`.
9. `SessionMetadata` response/snapshot construction uses a single named projection/read path. If W3's `stream:hello` snapshot includes `sessionMetadata`, it uses the same source as `/api/session-metadata`.
10. After W3 lands, the daemon-events `stream:hello` snapshot's `runs`, `queue`, `sessionMetadata`, and `autoBuild` fields are built through the same canonical helpers as their REST endpoints. There must be no parallel object-shaping code for those four fields in the snapshot constructor.
11. A run round-trip test writes/inserts a run with all fields populated, reads it through the REST `/api/runs` path or equivalent server handler, and deep-equals the canonical `RunInfo` JSON shape.
12. A W3 snapshot parity test seeds representative runs, queue items, session metadata, and auto-build state; then verifies the daemon `stream:hello` snapshot fields deep-equal the corresponding REST endpoint payloads.
13. Public API shapes remain unchanged. If implementation discovers and fixes a public shape bug, `DAEMON_API_VERSION` is bumped and the version comment/relevant tests explain the changed HTTP/SSE surface.
14. `AGENTS.md` documents the new convention for shared daemon wire shapes and projection helpers.
15. `pnpm type-check` and `pnpm test` pass.

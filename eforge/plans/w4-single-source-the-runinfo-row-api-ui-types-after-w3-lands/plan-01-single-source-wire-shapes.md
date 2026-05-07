---
id: plan-01-single-source-wire-shapes
name: Single-source RunInfo / QueueItem / SessionMetadata / AutoBuildState
branch: w4-single-source-the-runinfo-row-api-ui-types-after-w3-lands/plan-01-single-source-wire-shapes
agents:
  builder:
    effort: high
    rationale: "Cross-package type refactor with type-check enforcement: removing
      RunRecord and inline aliases requires updating every run read path in
      monitor/db.ts, both queue snapshot builders in server.ts, and the
      monitor-ui re-exports, all without changing public JSON shapes."
  reviewer:
    effort: high
    rationale: Daemon HTTP/SSE boundary work — reviewer must verify REST and
      stream:hello produce identical wire shapes and that no parallel
      object-shaping code remains.
---

# Single-source RunInfo / QueueItem / SessionMetadata / AutoBuildState

## Architecture Context

W3 has already landed: `packages/client/src/events.schemas.ts` defines `DaemonStreamSnapshotSchema` (with `runs`, `queue`, `sessionMetadata`, `autoBuild` fields), and `serveDaemonEventsSSE` in `packages/monitor/src/server.ts` already builds a `daemonSnapshot` and emits it via `writeHello(...)` as the first SSE frame. The wire shapes for `RunInfo`, `QueueItem`, `SessionMetadata`, and `AutoBuildState` are owned by `packages/client/src/types.ts` and re-exported via `packages/client/src/browser.ts`.

Duplicates and parallel projections currently exist:
- `packages/monitor/src/db.ts` defines its own `RunRecord` interface (line 6-16) returned from every run read method (`getRuns`, `getRunningRuns`, `getRun`, `getRunsBySession`, `getSessionRuns`). Run SELECT statements use inline camelCase aliases: `session_id as sessionId`, `plan_set as planSet`, `started_at as startedAt`, `completed_at as completedAt`.
- `packages/monitor/src/db.ts` also defines its own `SessionMetadata` interface (line 97-100), parallel to the canonical one in `packages/client/src/types.ts`.
- `packages/monitor/src/server.ts` declares a local inline `type QueueItem = { ... }` inside `serveQueue` (line 987) and a parallel `SnapshotItem` shape inside `buildQueueSnapshotSync` (line 894). The daemon `stream:hello` snapshot also hand-builds its own `autoBuild` literal (lines 440-443) parallel to the `GET /api/auto-build` handler (lines 1521-1524, 1568-1571).
- `packages/monitor-ui/src/lib/types.ts` re-declares its own `QueueItem`, `RunInfo`, and `SessionMetadata` interfaces (lines 43-81). The duplicate `RunInfo` is missing the canonical `pid?: number` field.

## Implementation

### Overview

Make `@eforge-build/client` the single source of truth for `RunInfo`, `QueueItem`, `SessionMetadata`, and `AutoBuildState`. Replace duplicate types and inline projections with named projection helpers that REST endpoints and the W3 `stream:hello` snapshot share. No public JSON shape changes; no SQLite migration; no `DAEMON_API_VERSION` bump.

### Key Decisions

1. **Keep `packages/client/src/types.ts` unchanged.** The canonical `RunInfo`, `QueueItem`, `SessionMetadata`, and `AutoBuildState` shapes already match the wire JSON. Do not export DB row types from the client package.
2. **Add a private `RunRow` daemon type and `rowToRunInfo(row: RunRow): RunInfo` helper inside `packages/monitor/src/db.ts`.** Construct the returned `RunInfo` via an explicit object literal so a new required `RunInfo` field forces a `pnpm type-check` failure when the helper is not updated. Do not reuse `RunInfo` keys via spread.
3. **Switch run SELECT statements to plain snake_case columns.** Drop the inline `as sessionId`, `as planSet`, `as startedAt`, `as completedAt` aliases for run reads. The `getLatestSessionId`, `getSessionMetadataEvents`, and file-diff statements stay aliased — they are out of scope (they don't feed the W3 wire fields).
4. **Remove duplicate `SessionMetadata` from `db.ts`.** Import the canonical `SessionMetadata` from `@eforge-build/client` and use it on `getSessionMetadataBatch()`.
5. **Add named projection helpers in `packages/monitor/src/server.ts`:**
   - `loadQueueItems(cwd, queueDir, lockDir): Promise<QueueItem[]>` — async, replaces inline `serveQueue` body.
   - `loadQueueItemsSync(cwd, queueDir, lockDir): QueueItem[]` — sync version used by `stream:hello`, replaces `buildQueueSnapshotSync`.
   - `autoBuildStateToWire(state: DaemonState | undefined): AutoBuildState` — used by `GET /api/auto-build` (GET and POST responses) and the `stream:hello` snapshot.
   Both queue helpers return the canonical `QueueItem[]` from `@eforge-build/client`. Either share the directory-scan body via a third helper (e.g. `scanQueueDir` parameterised by sync/async fs) or factor out a small adapter — the goal is no duplicate item-shaping code.
6. **Re-export shared types from `packages/monitor-ui/src/lib/types.ts`.** Replace the local `QueueItem`, `RunInfo`, and `SessionMetadata` interfaces with `import type` + `export type` from `@eforge-build/client/browser`. Existing `@/lib/types` imports continue to resolve.
7. **Stream:hello already calls `db.getRuns()`, `db.getSessionMetadataBatch()`, and an inline `buildQueueSnapshotSync()`.** After this plan: `db.getRuns()` returns canonical `RunInfo[]`, `db.getSessionMetadataBatch()` returns canonical `SessionMetadata`, the snapshot calls the new `loadQueueItemsSync` helper, and the snapshot's `autoBuild` field is constructed via `autoBuildStateToWire(options?.daemonState)` — the same helper used by `serveAutoBuildGet`/`serveAutoBuildSet` responses.
8. **No `event-registry.ts` changes are required.** It already imports `RunInfo`, `QueueItem`, and `AutoBuildState` from `./types.js`; the canonical types are unchanged.
9. **No `DAEMON_API_VERSION` bump.** Public JSON shapes are unchanged; this is implementation-only.

## Scope

### In Scope

- Delete `RunRecord` from `packages/monitor/src/db.ts`.
- Add private `RunRow` type and `rowToRunInfo` helper in `packages/monitor/src/db.ts`.
- Switch all run SELECT statements (`getRuns`, `getRunningRuns`, `getRun`, `getRunsBySession`, `getSessionRuns`) to plain snake_case columns and route every read result through `rowToRunInfo`.
- Replace the duplicate `SessionMetadata` interface in `db.ts` with the canonical import from `@eforge-build/client`.
- Replace `serveQueue`'s inline `type QueueItem = ...` and `buildQueueSnapshotSync`'s inline `SnapshotItem` with one or two named projection helpers (`loadQueueItems` async + `loadQueueItemsSync` sync) that return the canonical `QueueItem[]`. Item-shape construction must not be duplicated between the two.
- Add `autoBuildStateToWire(state: DaemonState | undefined): AutoBuildState` and use it in three call sites: `serveAutoBuildGet` body, `serveAutoBuildSet` response body, and the `stream:hello` daemon snapshot construction.
- Confirm the `stream:hello` daemon snapshot's `runs`, `queue`, `sessionMetadata`, and `autoBuild` fields are produced by exactly the same code paths as `/api/runs`, `/api/queue`, `/api/session-metadata`, and `/api/auto-build`.
- Replace duplicate `QueueItem`, `RunInfo`, and `SessionMetadata` interfaces in `packages/monitor-ui/src/lib/types.ts` with re-exports from `@eforge-build/client/browser`.
- Add a run round-trip test: insert a run with all `RunInfo` fields populated (including `pid`, `sessionId`, `completedAt`), read via the REST `/api/runs` handler, deep-equal against the canonical wire shape.
- Add a `stream:hello` parity test: seed runs/queue items/session-metadata events/auto-build state, then deep-equal the daemon snapshot's `runs`/`queue`/`sessionMetadata`/`autoBuild` fields against the corresponding REST endpoint payloads.
- Add the new convention to `AGENTS.md`.

### Out of Scope

- SQLite schema changes; no column renames; no migration. Existing `monitor.db` files must continue to load.
- `EventRecord`, `parseEventRow`, event-row aliases, and event/file-diff column aliasing — those belong to a separate Zod-spine refactor.
- Public `RunInfo`, `QueueItem`, `SessionMetadata`, or `AutoBuildState` JSON shape changes. If a real bug is found that requires a shape change, bump `DAEMON_API_VERSION` and document why; otherwise the version stays put.
- Adopting TypeBox / Zod for these non-event API shapes.
- Queue scheduling, recovery sidecar logic, auto-build watcher behavior, or session metadata semantics.
- Changes to `packages/client/src/event-registry.ts` beyond confirming compilation against the unchanged canonical types.

## Files

### Modify

- `packages/monitor/src/db.ts`
  - Delete the `export interface RunRecord { ... }` block (lines 6-16).
  - Delete the `export interface SessionMetadata { ... }` block (lines 97-100).
  - Add `import type { RunInfo, SessionMetadata } from '@eforge-build/client';` near the top (alongside the existing `DAEMON_EVENT_TYPES` import).
  - Add a private `RunRow` interface (snake_case columns) and a `rowToRunInfo(row: RunRow): RunInfo` helper. The helper must build the returned object explicitly (not via spread) so omitting a `RunInfo` field fails type-check.
  - Update the `MonitorDB` interface so `getRuns`, `getRunningRuns`, `getRun`, `getRunsBySession`, `getSessionRuns` return `RunInfo[]` / `RunInfo | undefined` and `getSessionMetadataBatch` returns `Record<string, SessionMetadata>` from the canonical client type.
  - Update prepared SQL for `getRuns`, `getRunningRuns`, `getRun`, `getRunsBySession` to plain `SELECT id, session_id, plan_set, command, status, started_at, completed_at, cwd, pid FROM runs ...` (no inline aliases).
  - Update each run read-path implementation to cast rows to `RunRow[]` / `RunRow | undefined` and pass through `rowToRunInfo`. `getSessionRuns` continues to delegate to the same prepared statement as `getRunsBySession`, also via `rowToRunInfo`.
  - Leave `getLatestSessionId`, `getSessionMetadataEvents`, `getDaemonEventsAfter`, `getMaxDaemonEventId`, file-diff statements, and event statements untouched (out of scope).

- `packages/monitor/src/server.ts`
  - Add `import type { QueueItem, AutoBuildState, RunInfo, SessionMetadata } from '@eforge-build/client';` (extending the existing client import group).
  - Refactor `serveQueue` (line ~977) and `buildQueueSnapshotSync` (line ~879) so they share a single item-shaping path. Recommended: rename to `loadQueueItems` (async) and `loadQueueItemsSync` (sync), each returning `QueueItem[]`. Remove the local `type QueueItem = { ... }` declarations and the local `SnapshotItem` declaration.
  - Add a `function autoBuildStateToWire(state: DaemonState | undefined): AutoBuildState { ... }` helper. Replace the three inline `{ enabled: ..., watcher: ... }` literals at lines 440-443 (stream:hello snapshot), 1521-1524 (GET /api/auto-build), and 1568-1571 (POST /api/auto-build) with calls to this helper.
  - The daemon `stream:hello` snapshot construction must call `db.getRuns()`, `loadQueueItemsSync(...)`, `db.getSessionMetadataBatch()`, and `autoBuildStateToWire(options?.daemonState)` — i.e. exactly the same code paths the REST handlers call.
  - Type the local `daemonSnapshot` literal inline with the existing `DaemonStreamSnapshotSchema`-aligned shape (no separate exported type needed).

- `packages/monitor-ui/src/lib/types.ts`
  - Delete the local `QueueItem`, `RunInfo`, and `SessionMetadata` interface declarations (lines 43-81).
  - Add `QueueItem`, `RunInfo`, and `SessionMetadata` to the `export type { ... } from '@eforge-build/client/browser'` block at the top. Existing `@/lib/types` consumers continue to resolve.
  - Confirm the `RunInfo` re-export now carries the canonical `pid?: number` field (UI gains it transparently).

- `AGENTS.md`
  - In the Conventions section, add a bullet: "Daemon wire shapes for runs, queue items, session metadata, and auto-build are owned by `@eforge-build/client`. Daemon DB read paths must use named row-to-wire mapping helpers (e.g. `rowToRunInfo`) rather than inline SQL camelCase aliases. REST handlers and the `stream:hello` SSE snapshot must construct `runs`, `queue`, `sessionMetadata`, and `autoBuild` through the same projection functions — no parallel object-shaping in the snapshot constructor or local interface re-declarations in monitor packages."

### Tests

- `packages/monitor/src/__tests__/runs-roundtrip.test.ts` (new)
  - Insert a run via `db.insertRun({ id, sessionId, planSet, command, status: 'completed', startedAt, cwd, pid })` and update with `completedAt` so every optional `RunInfo` field is populated.
  - Start the server via `startServer(db, 0, { cwd })`, fetch `GET /api/runs`, JSON-parse, deep-equal against the expected canonical `RunInfo` JSON. Assert the response array contains exactly one run with all fields set.
  - Add a second case: insert a run with no `pid` and no `sessionId`/`completedAt`; assert the wire object omits those keys (does not serialize `null` for them) — verifies `rowToRunInfo` does not introduce undefined fields that would change the JSON shape.

- `packages/monitor/src/__tests__/stream-hello-parity.test.ts` (new)
  - Seed: insert two runs (one running, one completed with all fields populated); insert `session:profile` and `planning:complete` events to populate session metadata for one session; insert one queue PRD `.md` file under `eforge/queue/`; configure `daemonState` with `{ autoBuild: true, autoBuildPaused: false, watcher: { running: true, pid: 99, sessionId: 'sess-99' }, ... }` (use a minimal `DaemonState` literal — the helper handler fields like `onSpawnWatcher` can be omitted).
  - Start the server with `startServer(db, 0, { cwd, daemonState })`.
  - Connect via `http.get` to `/api/daemon-events`, capture the first SSE block (the `stream:hello` frame), JSON-parse the `data:` payload to extract `{ runs, queue, sessionMetadata, autoBuild }`.
  - Independently fetch `GET /api/runs`, `GET /api/queue`, `GET /api/session-metadata`, and `GET /api/auto-build`. JSON-parse each.
  - Assert `expect(snapshot.runs).toEqual(restRuns)`, `expect(snapshot.queue).toEqual(restQueue)`, `expect(snapshot.sessionMetadata).toEqual(restSessionMetadata)`, `expect(snapshot.autoBuild).toEqual(restAutoBuild)`.

## Verification

- [ ] `RunRecord` is removed from `packages/monitor/src/db.ts` (`grep -n 'RunRecord' packages/monitor/src/db.ts` returns zero hits).
- [ ] The local `SessionMetadata` interface in `packages/monitor/src/db.ts` is removed; the file imports `SessionMetadata` from `@eforge-build/client`.
- [ ] `packages/monitor/src/db.ts` exposes a `rowToRunInfo` helper (or equivalently named function) that returns `RunInfo` and is the only DB-row → run-wire mapping in the file.
- [ ] `getRuns`, `getRunningRuns`, `getRun`, `getRunsBySession`, and `getSessionRuns` each pass their result through `rowToRunInfo` and have return types that resolve to the canonical `RunInfo` from `@eforge-build/client`.
- [ ] Run SELECT statements in `packages/monitor/src/db.ts` no longer use inline camelCase aliases for `RunInfo` fields: `grep -nE 'as (sessionId|planSet|startedAt|completedAt)' packages/monitor/src/db.ts` returns zero hits inside run prepared statements.
- [ ] `packages/monitor-ui/src/lib/types.ts` no longer defines local `QueueItem`, `RunInfo`, or `SessionMetadata` interfaces (`grep -nE '^export interface (QueueItem|RunInfo|SessionMetadata)' packages/monitor-ui/src/lib/types.ts` returns zero hits); those names are re-exported from `@eforge-build/client/browser`.
- [ ] `packages/monitor/src/server.ts` no longer contains a local `type QueueItem = ` declaration (`grep -nE '^[[:space:]]*type QueueItem ?=' packages/monitor/src/server.ts` returns zero hits).
- [ ] `serveQueue` and the `stream:hello` queue snapshot share a single item-shaping path; `serveQueue`'s response and the snapshot's `queue` field both have type `QueueItem[]` from `@eforge-build/client`.
- [ ] `autoBuildStateToWire(...)` exists in `packages/monitor/src/server.ts` and is the single source of `AutoBuildState` JSON for `GET /api/auto-build`, `POST /api/auto-build` response, and the `stream:hello` snapshot's `autoBuild` field.
- [ ] The `stream:hello` daemon snapshot constructor calls `db.getRuns()`, the shared queue helper, `db.getSessionMetadataBatch()`, and `autoBuildStateToWire(...)` — no inline `{ enabled: ..., watcher: ... }` object literal, no inline queue-item construction, no parallel run/session-metadata transformation.
- [ ] Adding a hypothetical required field to `RunInfo` (test locally during review) produces a `pnpm type-check` failure pointing at `rowToRunInfo`.
- [ ] Pre-existing `monitor.db` files load without migration: `pnpm test` exercises `openDatabase` against fresh and migrated DBs successfully.
- [ ] New test `packages/monitor/src/__tests__/runs-roundtrip.test.ts` passes: `GET /api/runs` returns a deep-equal canonical `RunInfo` for a run with all fields populated, and omits optional keys for runs without them.
- [ ] New test `packages/monitor/src/__tests__/stream-hello-parity.test.ts` passes: `stream:hello` snapshot fields `runs`, `queue`, `sessionMetadata`, and `autoBuild` are deep-equal to the corresponding REST endpoint payloads when both observe the same daemon state.
- [ ] `AGENTS.md` Conventions section contains a new bullet documenting the wire-shape ownership and projection-helper convention.
- [ ] `pnpm type-check` exits zero.
- [ ] `pnpm test` exits zero (all existing daemon SSE handshake tests, db tests, and the two new tests pass).
- [ ] `DAEMON_API_VERSION` in `packages/client/src/api-version.ts` is unchanged (no public shape changes).

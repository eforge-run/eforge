---
title: Close the cold-start black hole in auto-build
created: 2026-04-23
---

# Close the cold-start black hole in auto-build

## Problem / Motivation

After a daemon restart, builds appear to start with a ~1 minute delay and never pass through a visible "queued" state in the monitor UI. Investigation (lock-file timestamps, process tree) showed both child subprocesses actually spawn within 1 second of daemon startup — so the scheduler is not slow. The visible delay is the child subprocess cold-start (Node import + module load + `EforgeEngine.create()` + backend init) before the child emits its first event.

During that 15–60s cold-start window, the build shows up in **neither** UI panel:

- **Not in the Queue panel** — a lock file exists, so `/api/queue` reports `status='running'`, which the panel filters out (and the filter is correct: it's there to prevent the build from appearing twice, once in the queue and once in the sidebar).
- **Not in the Sessions sidebar** — the child hasn't emitted `session:start` yet, so no `runs` row exists.

This is what makes the user-visible behavior look like "builds vanish for a minute after daemon restart, then pop into existence as 'running'."

### Root cause

The parent scheduler (`engine.watchQueue → startReadyPrds → spawnPrdChild` in `packages/engine/src/eforge.ts`) spawns the child and then waits for the child to emit its own `session:start` with a fresh `randomUUID()` (at `eforge.ts:896` inside `buildSinglePrd`). The parent never registers the session itself, so nothing is in the DB until the child finishes cold-starting.

## Goal

Eliminate the cold-start black hole so that builds appear in the Sessions sidebar as `running` within ~1s of daemon startup, by having the parent scheduler own the `sessionId` and emit `session:start` at spawn time rather than waiting for the child.

## Approach

**Parent owns the sessionId and announces it at spawn time.** One change, with three concrete edits.

### Edit 1 — parent generates the sessionId, emits `session:start`, and passes the id to the child

`packages/engine/src/eforge.ts`, in `startReadyPrds()` inside `watchQueue()` (around line 1434):

Right after `state.status = 'running'` and before `void (async () => { ... })`, generate `const prdSessionId = randomUUID();` and push a `session:start` event onto `eventQueue` (pattern matches the existing yields in `buildSinglePrd`). Pass `prdSessionId` into `spawnPrdChild(prd, options, prdSessionId)`.

In `spawnPrdChild` (around line 1000), append `'--session-id', prdSessionId` to `args`.

`runQueue()` (non-watcher path, around line 1197) gets the same three-line change for consistency.

### Edit 2 — child accepts and uses the injected sessionId

`packages/eforge/src/cli/index.ts`, `queue exec` subcommand: parse `--session-id <uuid>` and pass it through to `buildSinglePrd`.

`packages/engine/src/eforge.ts`, `buildSinglePrd` signature: add an optional `sessionId?: string` parameter. At line 896, replace `const prdSessionId = randomUUID()` with `const prdSessionId = sessionId ?? randomUUID()`. Drop the `session:start` emission in `buildSinglePrd` (line 903) when `sessionId` was passed in — the parent already emitted it. Keep `session:end` in the child (it's still the right party to emit terminal state).

### Edit 3 — nothing

`withRecording` (monitor side) already persists `session:start` → `runs` row. No changes needed there. Sidebar will pick up the run via its existing query the moment the parent's event lands in the DB, which is within ms of the `spawn()` call.

## Scope

### In scope

- Modifying `packages/engine/src/eforge.ts`:
  - `watchQueue` / `startReadyPrds` — generate sessionId, emit `session:start`, pass id to `spawnPrdChild`
  - `spawnPrdChild` — append `--session-id <uuid>` to child args
  - `runQueue` (non-watcher path) — same three-line change for consistency
  - `buildSinglePrd` — accept optional `sessionId?: string`, use injected id when provided, suppress duplicate `session:start` emission when injected
- Modifying `packages/eforge/src/cli/index.ts`:
  - `queue exec` subcommand — parse `--session-id <uuid>` and forward to `buildSinglePrd`
- Adjusting any test that asserts `session:start` is emitted by `buildSinglePrd` unconditionally.

### Out of scope

- Changes to `withRecording` or the monitor-side persistence layer (no changes needed).
- Changes to where `session:end` is emitted (still emitted by the child).
- Changes to the Queue panel filter that hides `status='running'` entries (filter behavior is correct).

## Critical files

- `packages/engine/src/eforge.ts` — `watchQueue`, `runQueue`, `startReadyPrds`, `spawnPrdChild`, `buildSinglePrd`
- `packages/eforge/src/cli/index.ts` — `queue exec` subcommand args

## Acceptance Criteria

Verification procedure:

1. Stop daemon, clear `.eforge/queue-locks/`.
2. Put 3 PRDs in `eforge/queue/` (two ready, one dep-blocked), set `maxConcurrentBuilds: 2`, auto-build on.
3. Start daemon, open monitor UI immediately.
4. Within ~1s: two builds appear in the **Sessions sidebar** as `running` (no more cold-start black hole). The dep-blocked PRD appears in the Queue panel with its `blocked by:` hint.
5. No PRD appears twice (filter still works because the spawned ones are now proper sessions).
6. `sqlite3 .eforge/monitor.db "SELECT id, status, started_at FROM runs ORDER BY started_at DESC LIMIT 5"` — the two run rows should timestamp within a second of daemon startup, not 15–60s after.
7. `pnpm test` passes — especially `test/agent-wiring.test.ts`, `test/greedy-queue-scheduler.test.ts`, `test/reconciler.test.ts`. Adjust any test that asserts `session:start` is emitted by `buildSinglePrd` unconditionally.

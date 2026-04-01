---
title: Fix: Daemon stops watching queue after build completion
created: 2026-04-01
depends_on: []
---

# Fix: Daemon stops watching queue after build completion

## Problem / Motivation

After a build session completes (success or failure), the daemon stops picking up new items from `eforge/queue/`. The UI monitor still shows auto-build as enabled, but no new PRDs are processed. A daemon restart restores normal behavior. This is caused by three interrelated bugs:

1. **Queue directory gets deleted after successful builds**, killing the `fs.watch` that monitors it. On a successful build, `cleanupPlanFiles()` removes the PRD file via `git rm`, then deletes the empty parent directory (`src/engine/cleanup.ts:49-57`). Additionally, when the merge worktree's feature branch is merged back to main, git itself removes the now-empty `eforge/queue/` directory from the working tree. This causes `fs.watch` to error, which triggers `onAbort()` (`src/engine/eforge.ts:1300-1302`), removing the fs.watch producer from the event queue. With no producers left, the `for await` loop terminates and the watcher process exits with code 0. The daemon's exit handler (`src/monitor/server-main.ts:331`) treats code 0 as "clean exit - no respawn needed", leaving `autoBuild = true` with no watcher running.

2. **prdState cache prevents re-discovery** of PRDs moved back from `failed/`. `discoverNewPrds()` (`src/engine/eforge.ts:1207`) checks `if (!prdState.has(prd.id))` and skips PRDs already in the map. When a user moves a failed PRD back to `eforge/queue/`, its id is still in `prdState` with status `'failed'`, so `isReady()` returns false and it's never re-started.

3. **Daemon exit handler doesn't recover** from unexpected watcher exits. `src/monitor/server-main.ts:324` - `if (code !== 0 && code !== null)` fails when the watcher is killed by a signal (code is `null`), leaving autoBuild enabled with no watcher.

## Goal

Make the daemon's queue watcher resilient to directory deletion, re-queued PRDs, and unexpected exits so that builds are continuously picked up without manual daemon restarts.

## Approach

### 1. Make fs.watch resilient to directory deletion

**File: `src/engine/eforge.ts`** - `watchQueue()` method

Replace the error handler at line 1300-1302 with a recovery function:

- On fs.watch error: close the broken watcher, recreate the queue directory with `mkdir(absQueueDir, { recursive: true })`, establish a new `fs.watch`, and call `discoverNewPrds()` + `startReadyPrds()` to catch anything missed during the gap.
- Extract the watcher setup into a helper so it can be called both initially and during recovery.
- Add a retry limit (max 3 consecutive failures within 10 seconds) to prevent infinite loops - after exhausting retries, fall back to `onAbort()`.

### 2. Stop deleting the queue directory in cleanup

**File: `src/engine/cleanup.ts`** - lines 49-57

Remove the block that deletes the PRD's parent directory. The queue directory is the watcher's root and must survive builds. Keep the PRD file deletion via `git rm`.

**File: `src/engine/prd-queue.ts`** - lines 286-288

Remove `rmdir(absQueueDir)` from `cleanupCompletedPrd()`. This is a latent hazard even though it's not actively called in the watch queue path.

### 3. Daemon respawns watcher on unexpected exit

**File: `src/monitor/server-main.ts`** - lines 312-333

Rewrite the exit handler:

- Capture `signal` parameter: `child.on('exit', (code, signal) => { ... })`
- After the `watcherKilledByUs` check, handle three cases:
  - `code !== 0 && code !== null`: non-zero exit (current behavior - disable autoBuild)
  - `signal !== null`: signal kill - disable autoBuild (new)
  - `code === 0`: clean exit. If `autoBuild` is still true and not killed by us, respawn after `respawnDelayMs` delay
- Add a circuit breaker: max 3 respawns within 60 seconds, then disable autoBuild to prevent runaway respawning.

### 4. Reset prdState for re-queued PRDs

**File: `src/engine/eforge.ts`** - `discoverNewPrds()` function

Add an `else` branch after `if (!prdState.has(prd.id))`:

When a PRD id exists in `prdState` with status `'failed'` or `'blocked'`, reset its status to `'pending'`, update its `dependsOn`, replace the stale entry in `orderedPrds` with the fresh PRD object (which has the correct `filePath`), and push a `queue:prd:discovered` event.

## Scope

**In scope:**

- fs.watch recovery logic in `src/engine/eforge.ts`
- Removing queue directory deletion from `src/engine/cleanup.ts` and `src/engine/prd-queue.ts`
- Daemon exit handler rewrite in `src/monitor/server-main.ts`
- prdState reset logic for re-queued PRDs in `src/engine/eforge.ts`
- Unit tests for fs.watch recovery, prdState reset on re-queued PRDs, and daemon respawn logic

**Out of scope:**

- N/A

## Acceptance Criteria

- After a successful build completes, a newly enqueued PRD in `eforge/queue/` is picked up by the watcher without a daemon restart.
- After a failed build, moving the PRD file back to `eforge/queue/` causes it to be re-discovered and re-started.
- If the watcher process is killed by a signal, the daemon disables autoBuild (rather than leaving it enabled with no watcher).
- If the watcher exits with code 0 while autoBuild is still true and the daemon did not kill it, the daemon respawns the watcher.
- A circuit breaker prevents runaway respawning: max 3 respawns within 60 seconds, after which autoBuild is disabled.
- fs.watch recovery retries up to 3 consecutive failures within 10 seconds before falling back to `onAbort()`.
- The queue directory (`eforge/queue/`) is never deleted by cleanup code.
- `pnpm test` passes with no regressions.

**Critical Files:**

- `src/engine/eforge.ts` - fixes 1 and 4 (watchQueue method, discoverNewPrds)
- `src/engine/cleanup.ts` - fix 2 (cleanupPlanFiles)
- `src/engine/prd-queue.ts` - fix 2 (cleanupCompletedPrd)
- `src/monitor/server-main.ts` - fix 3 (daemon exit handler)

---
title: Plan: Fix watcher race condition — PRD processed twice
created: 2026-03-24
status: pending
---

## Problem / Motivation

When a build is triggered via the daemon, the monitor shows two sidebar entries for the same PRD. DB investigation confirmed this is NOT the enqueue session leaking through — `partitionEnqueueSessions()` correctly filters it. Instead, **two watcher invocations both picked up the same PRD within 12ms**, before either could mark it as `running` in the frontmatter:

```
Session 7236af6b: compile (completed) + build (completed)  — started 04:41:26.746
Session 04297968: compile (completed) + build (killed)     — started 04:41:26.758
```

The enqueue session (`2a4914b4`) is separate and correctly hidden.

**Root cause:** `runQueue()` calls `updatePrdStatus(prd.filePath, 'running')` (async file write) before processing. But `loadQueue()` reads all PRD files and returns pending ones. If two watcher processes (or a respawned watcher) both call `loadQueue()` before either writes `running`, both see the PRD as `pending` and process it. The daemon's `spawnWatcher()` has a guard (`if (watcherProcess) return`), but there's likely a small window during watcher respawn (exit event → respawn) where two processes overlap.

## Goal

Eliminate the race condition so that only one watcher process can claim and process a given PRD, ensuring a single monitor sidebar entry per build.

## Approach

### 1. Add lockfile-based claim to `prd-queue.ts` (`src/engine/prd-queue.ts`)

Add `claimPrd(filePath)` and `releasePrd(filePath)`:

- `claimPrd`: creates `{filePath}.lock` with `O_CREAT | O_EXCL` (atomic — fails if file exists). If lock acquired, updates status to `running` and returns `true`. If `EEXIST`, another process claimed it — returns `false`.
- `releasePrd`: removes the `.lock` file (best-effort, non-throwing).

### 2. Use claim/release in `runQueue()` (`src/engine/eforge.ts`)

Before processing each PRD (~line 634), call `claimPrd()`. If it returns `false`, skip the PRD. In the `finally` block of per-PRD processing, call `releasePrd()`.

## Scope

**In scope:**
- `src/engine/prd-queue.ts` — Add `claimPrd()` and `releasePrd()` functions using exclusive file creation
- `src/engine/eforge.ts` — Use `claimPrd()` in `runQueue()` before processing each PRD, `releasePrd()` in finally block

**Out of scope:**
- N/A

## Acceptance Criteria

1. `pnpm test` — existing tests pass
2. Triggering a build via daemon results in only ONE entry in the monitor sidebar
3. `.lock` files are cleaned up after build completes
4. Foreground builds (`eforge build --foreground`) still work
5. Killing a build mid-flight cleans up the lockfile (via finally block)

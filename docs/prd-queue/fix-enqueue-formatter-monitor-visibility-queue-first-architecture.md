---
title: Fix: Enqueue/Formatter Monitor Visibility + Queue-First Architecture
created: 2026-03-23
status: running
---

# Fix: Enqueue/Formatter Monitor Visibility + Queue-First Architecture

## Problem / Motivation

When `eforge_build` is called via the MCP tool, the formatter/enqueue runs as one worker process and the compile/build runs as a separate watcher process. This causes two problems:

1. **False "Failed" status**: `runSession()` derives session result from `phase:end` only. Enqueue never emits `phase:end`, so the session falls back to `{ status: 'failed' }`. The recorder then overwrites the run's 'completed' status back to 'failed'.

2. **Confusing split sessions**: Enqueue and build appear as separate sessions with no clear relationship. The user expects to see enqueue operations in their own section, not mixed into the sessions list.

Additionally, the foreground `eforge build source.md --foreground` path fuses enqueue+compile+build into one session, bypassing the queue. This queue-skipping violates the queue-first architecture — everything should flow through the queue.

## Goal

Ensure enqueue operations report correct status (not false "failed"), appear in a dedicated UI section in the monitor sidebar, and all build paths (including `--foreground`) flow through the queue rather than fusing enqueue+compile+build into a single session.

## Approach

### 1. Fix `runSession()` to recognize `enqueue:complete` as success

**File**: `src/engine/session.ts` (line 63-65)

Add `enqueue:complete` tracking alongside `phase:end`:

```typescript
if (event.type === 'phase:end') {
  lastResult = event.result;
} else if (event.type === 'enqueue:complete') {
  lastResult = { status: 'completed', summary: `Enqueued: ${event.title}` };
}
```

Safe because `phase:end` naturally overrides it in mixed sessions.

### 2. Remove the fused foreground build path

**File**: `src/cli/index.ts` (lines ~274-443)

Replace the `allPhases()` fused generator with two separate phases:

1. **Enqueue phase**: `engine.enqueue(source)` wrapped in its own `runSession()` — runs formatter, writes PRD to queue
2. **Queue processing phase**: `engine.runQueue()` — processes the just-enqueued PRD (and any other pending PRDs)

Both phases get their own `sessionId` and go through `withMonitor` + hooks. This makes `--foreground` behave identically to the daemon path, just in-process.

Key simplifications:
- Remove the `allPhases()` async generator (lines 327-406)
- Remove pre-compile HEAD recording/reset logic (lines 348-354, 435-439) — `runQueue()` handles this internally
- Remove manual `finalResult`/`planResult` tracking — `runQueue()` reports its own status
- Keep `--dry-run` support: pass it through to `runQueue()` options
- Keep `--name` support: pass it through to `runQueue()` as `options.name`

### 3. UI: Add "Recent Enqueues" section above the queue

**File**: `src/monitor/ui/src/lib/session-utils.ts`

Update `groupRunsBySessions()` to separate enqueue runs from session groups. Return a new data structure or a separate filtered list. The simplest approach: add a utility that partitions runs by `command === 'enqueue'` vs everything else. Enqueue-only sessions (sessions where all runs are enqueue commands) get pulled out of the sessions list.

**File**: `src/monitor/ui/src/components/layout/sidebar.tsx`

Add a new `EnqueueSection` between `QueueSection` and the Sessions list. Similar to `QueueSection` — a collapsible list showing recent enqueue operations with their status (completed/failed/running), title, and duration. Clicking one navigates to its events.

**New file**: `src/monitor/ui/src/components/layout/enqueue-section.tsx`

Collapsible component that:
- Receives enqueue session groups from the sidebar
- Shows each with a status icon, title, relative time, and duration
- Clicking selects it (same `onSelectSession` callback)
- Shows only recent enqueues (last N or last 24h) to avoid clutter

### 4. Tests

- **`test/session.test.ts`**: Add test that `runSession()` with enqueue-only events produces `session:end` with `status: 'completed'`
- **`test/monitor-recording.test.ts`**: Verify enqueue run stays 'completed' after the session.ts fix

## Scope

**In scope:**
- Fixing `runSession()` to recognize `enqueue:complete` as a success signal
- Replacing the fused `--foreground` build path with enqueue + `runQueue()` (two separate phases)
- Adding a "Recent Enqueues" section to the monitor sidebar UI
- Partitioning enqueue-only sessions out of the main sessions list
- New tests for enqueue session result and monitor recording correctness

**Out of scope:**
- N/A

## Acceptance Criteria

| # | Criterion |
|---|-----------|
| 1 | `pnpm test` passes — all existing tests plus new enqueue session and monitor recording tests |
| 2 | `pnpm type-check` reports no type errors |
| 3 | `pnpm build` completes cleanly |
| 4 | `runSession()` with enqueue-only events (no `phase:end`) produces `session:end` with `status: 'completed'` and a summary containing the enqueued title |
| 5 | After calling `eforge_build` via MCP tool and restarting the daemon, the monitor sidebar shows the enqueue operation in a "Recent Enqueues" section (above the queue) with a green checkmark — not as a false "Failed" session |
| 6 | Build sessions appear separately in the Sessions list with their own lifecycle, distinct from enqueue operations |
| 7 | `eforge build source.md --foreground` executes as two phases (enqueue then queue processing), not a fused single session |
| 8 | `--dry-run` and `--name` flags continue to work correctly through the new queue-based foreground path |

### Key Files

| File | Change |
|------|--------|
| `src/engine/session.ts` | Recognize `enqueue:complete` as success signal |
| `src/cli/index.ts` | Replace fused build path with enqueue + runQueue |
| `src/monitor/ui/src/components/layout/sidebar.tsx` | Add EnqueueSection, filter enqueue sessions out of sessions list |
| `src/monitor/ui/src/components/layout/enqueue-section.tsx` | New: collapsible enqueue operations section |
| `src/monitor/ui/src/lib/session-utils.ts` | Partition enqueue-only sessions from build sessions |
| `test/session.test.ts` | Enqueue-only session result test |
| `test/monitor-recording.test.ts` | Updated enqueue recording test |

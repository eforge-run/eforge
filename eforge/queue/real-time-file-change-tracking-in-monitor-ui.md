---
title: Real-time file change tracking in monitor UI
created: 2026-03-29
status: pending
---



# Real-time file change tracking in monitor UI

## Problem / Motivation

The monitor UI's "changes" tab (FileHeatmap) shows which files each plan has modified, but only updates at stage boundaries - after implement, review-fix, doc-update, or test-write stages complete. During the implement stage (which can run for minutes), the UI shows nothing. The `emitFilesChanged()` function already uses `git diff --name-only baseBranch` which captures committed, staged, AND unstaged changes, so the git command works for real-time tracking. The problem is purely that it's only called once per stage.

## Goal

Provide real-time file change visibility in the monitor UI during long-running build stages by periodically emitting file change events, with zero frontend changes and no new infrastructure.

## Approach

Piggyback on the existing event flow. During agent loops in build stages, periodically call `emitFilesChanged()` after `agent:tool_result` events (which indicate a tool completed and may have modified files). Throttle to avoid excessive git operations (5-second interval).

No new infrastructure needed - no file watchers, no background pollers, no new dependencies. The UI already handles `build:files_changed` events via SSE, so zero frontend changes are required.

Multi-worktree handling is automatic: each plan has its own `BuildStageContext` with `planId` + `worktreePath`, so parallel builds naturally emit correctly attributed per-plan file changes.

### Implementation details

**1. Extract a reusable wrapper in `src/engine/pipeline.ts`**

Add a helper that wraps any agent event generator with throttled file-change polling:

```typescript
const FILE_CHANGE_POLL_INTERVAL_MS = 5000;

async function* withFileChangePolling(
  inner: AsyncGenerator<EforgeEvent>,
  ctx: BuildStageContext,
): AsyncGenerator<EforgeEvent> {
  let lastFileCheck = 0;
  for await (const event of inner) {
    yield event;
    if (event.type === 'agent:tool_result') {
      const now = Date.now();
      if (now - lastFileCheck >= FILE_CHANGE_POLL_INTERVAL_MS) {
        lastFileCheck = now;
        yield* emitFilesChanged(ctx);
      }
    }
  }
}
```

**2. Apply to build stages with long-running agent loops**

Wrap the agent event iterators in these stages:

- **`implement`** (~line 993) - longest running stage, most impactful
- **`review-fix`** (`reviewFixStageInner`, ~line 1147) - applies reviewer fixes
- **`doc-update`** (~line 1246) - updates documentation
- **`test-write`** (~line 1292) - writes tests
- **`test`** (`testStageInner`, ~line 1328) - runs/fixes tests

The pattern change in each stage is minimal:

```typescript
// Before:
for await (const event of builderImplement(...)) {

// After:
for await (const event of withFileChangePolling(builderImplement(...), ctx)) {
```

Keep the existing `yield* emitFilesChanged(ctx)` calls at stage end as a final flush.

**Do NOT apply to**: `review` stage (reviewer is read-only, doesn't modify files), `evaluate` stage (evaluator accepts/rejects, doesn't create new files).

**3. No UI changes needed**

The reducer at `src/monitor/ui/src/lib/reducer.ts:219` already handles `build:files_changed` events by updating the `fileChanges` Map. The FileHeatmap re-renders when this map changes. More frequent events = more frequent UI updates, automatically.

### Files to modify

- `src/engine/pipeline.ts` - add `withFileChangePolling()` helper, wrap 5 agent loops

## Scope

**In scope:**

- New `withFileChangePolling()` async generator wrapper in `src/engine/pipeline.ts`
- Wrapping agent event iterators in 5 build stages: implement, review-fix, doc-update, test-write, test
- Throttled polling at 5-second intervals on `agent:tool_result` events

**Out of scope:**

- Frontend/UI changes (existing SSE handling and reducer already support this)
- File watchers, background pollers, or new dependencies
- Changes to the `review` or `evaluate` stages (read-only, no file modifications)

## Acceptance Criteria

- `pnpm build` compiles successfully
- `pnpm test` passes all existing tests
- During `eforge build` on a test PRD, the monitor web UI's changes tab populates during the implement stage (and other wrapped stages), not just after stage completion
- File change events are throttled to no more than once every 5 seconds per stage
- Parallel builds correctly attribute file changes to their respective plans
- Existing `emitFilesChanged()` calls at stage end are preserved as a final flush

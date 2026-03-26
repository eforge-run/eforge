---
title: Prevent eforge plugin from loading in eforge agents
created: 2026-03-26
status: pending
---

# Prevent eforge plugin from loading in eforge agents

## Problem / Motivation

eforge agents inherit all loaded plugins, including the eforge plugin itself (which provides MCP tools like `eforge_build`/`eforge_status` and skills like `/eforge:build`). The MCP proxy subprocess starts with the agent but doesn't contact the daemon on startup or tool listing - only on actual tool invocations. Occasionally an agent running in a worktree invokes an eforge MCP tool (e.g. checking build status), which triggers `ensureDaemon()`. Since the worktree has no `.eforge/daemon.lock`, a new daemon spawns there. That daemon never receives events and never shuts down, becoming an orphan.

This is rare (2 orphaned daemons across 407+ eforge-authored commits), but agents have no reason to use eforge tools during a build. The fix is to exclude the eforge plugin from agents entirely so the tools and skills aren't available to call, and to add a safety-net timeout so daemons that never receive events still shut down.

## Goal

Eliminate orphaned daemon processes by preventing eforge agents from loading the eforge plugin, and add a max-wait timeout to the daemon shutdown state machine as a safety net for daemons orphaned by other means.

## Approach

### 1. Auto-exclude `eforge@eforge` plugin in `loadPlugins()`

In `src/engine/eforge.ts`, add `eforge@eforge` to the exclude list before filtering. This is a self-referential exclusion - eforge should never load itself as a plugin for its agents.

**File:** `src/engine/eforge.ts` (line ~976, inside `loadPlugins()`)

Add before the existing `if (pluginConfig.include && ...)` check at line 977:

```typescript
// Never load eforge's own plugin — agents don't need eforge tools,
// and the plugin's MCP proxy would spawn orphaned daemons in worktrees.
const SELF_PLUGIN_PREFIX = 'eforge@';

// ... in the loop:
if (id.startsWith(SELF_PLUGIN_PREFIX)) continue;
```

Uses a prefix match (`eforge@`) rather than exact ID (`eforge@eforge`) to be robust against marketplace name changes.

### 2. Add `maxWaitForActivityMs` to shutdown state machine (safety net)

Even with the plugin exclusion, daemons can still be orphaned by other means (manual starts, crashes, etc.). Add a timeout to the `hasSeenActivity` gate so daemons that never receive events still shut down.

**File:** `src/monitor/server-main.ts`

- Add `maxWaitForActivityMs` field to `StateCheckContext` interface (line 32).
- In `evaluateStateCheck()`, in the `if (!hasSeenActivity)` block (line 79), check elapsed time since `serverStartedAt`. If `maxWaitForActivityMs > 0` and exceeded, force-transition to COUNTDOWN.
- Constant: `MAX_WAIT_FOR_ACTIVITY_MS = 300_000` (5 minutes).
- Wire it into the caller that creates the context (the interval callback in the ephemeral and persistent state machine sections).

### 3. Add tests for `maxWaitForActivityMs`

**File:** `test/monitor-shutdown.test.ts`

- Update `makeContext` helper to include `maxWaitForActivityMs: 0` (preserving existing test behavior).
- Add new tests:
  - Elapsed > `maxWaitForActivityMs` with no activity -> transitions to COUNTDOWN
  - Elapsed < `maxWaitForActivityMs` -> stays WATCHING
  - `maxWaitForActivityMs: 0` -> disabled, existing behavior preserved

## Scope

**In scope:**

| File | Change |
|------|--------|
| `src/engine/eforge.ts` | Skip `eforge@*` plugins in `loadPlugins()` loop |
| `src/monitor/server-main.ts` | Add `maxWaitForActivityMs` to `StateCheckContext` + `evaluateStateCheck()` |
| `test/monitor-shutdown.test.ts` | Add tests for `maxWaitForActivityMs`, update `makeContext` |

**Out of scope:**

N/A

## Acceptance Criteria

- `loadPlugins()` skips any plugin whose ID starts with `eforge@`, preventing eforge tools and skills from being available to agents.
- The daemon shutdown state machine includes a `maxWaitForActivityMs` field in `StateCheckContext`.
- If `maxWaitForActivityMs > 0` and elapsed time since `serverStartedAt` exceeds it with no activity, the daemon force-transitions to COUNTDOWN.
- If `maxWaitForActivityMs` is `0`, the timeout is disabled and existing behavior is preserved.
- New tests cover: elapsed > max wait triggers COUNTDOWN, elapsed < max wait stays WATCHING, and `maxWaitForActivityMs: 0` preserves existing behavior.
- `pnpm type-check` passes.
- `pnpm test` passes, including new tests.
- `pnpm build` succeeds.
- Verified that `loadPlugins` skips the eforge plugin (e.g., temporarily add a log, run `pnpm dev -- build --dry-run` on a test PRD and confirm eforge plugin is not in the loaded list).

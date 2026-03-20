---
title: Fix: session:end hook not firing on build failure
created: 2026-03-20
status: pending
---

## Problem / Motivation

When a build fails during `eforge run <source>` (single-source mode, launched via `/eforge:run` skill as a background task), the `session:end` hook doesn't fire. The hook calls a Schaake OS API endpoint to end session tracking, so missed firings leave sessions dangling.

Three underlying issues were identified by tracing the event chain (`allPhases()` → `runSession()` → `withHooks()` → `withRecording()` → CLI `for-await`):

1. **Hook drain timeout (3s) is shorter than hook execution timeout (5s).** In `src/engine/hooks.ts:158-168`, the `withHooks` finally block drains in-flight hooks with a hardcoded 3-second timeout, but the user's hook config has `timeout: 5000` (5 seconds) and the hook script calls `curl --max-time 5`. After the 3-second drain expires, the generator chain completes and `process.exit()` kills the hook subprocess mid-flight. On success the API response is likely fast (< 3s) so the hook completes before the drain expires. On failure the API endpoint may take longer (processing a failed session has different characteristics), pushing past the 3-second drain window. This is the primary suspect for single-source mode.

2. **No session lifecycle guarantee in `runQueue` (queue mode).** In `src/engine/eforge.ts:614-680`, the per-PRD section in `runQueue()` emits `session:start` and `session:end` without a `try/finally` wrapper. If any exception occurs between them (`compile()` throwing from pre-try code, `updatePrdStatus()` throwing, `build()` throwing from pre-try code), `session:end` is silently lost. The non-queue path is protected by `runSession()`'s `try/finally`, but queue mode manages session lifecycle manually without an equivalent guarantee.

3. **Pre-try code in `compile()` and `build()` can bypass `phase:end`.** Both `compile()` (line 183) and `build()` (line 324) call `validatePlanSetName()` before their `try` block. `createTracingContext()` and `tracing.setInput()` are also outside `try`. If these throw, the generator throws immediately and `phase:end` is never emitted from the `finally` block. In non-queue mode, `runSession` still emits `session:end` with a fallback result. In queue mode, this compounds into a missing `session:end`.

## Goal

Guarantee that the `session:end` hook always fires and completes - even on build failure - across both single-source and queue modes, and ensure `phase:end` events are emitted regardless of where exceptions occur.

## Approach

### 1. Derive drain timeout from configured hook timeouts

**File**: `src/engine/hooks.ts`

Instead of a hardcoded 3-second drain, compute the drain timeout from the maximum configured hook timeout:

```typescript
// In withHooks, before the try block:
const maxTimeout = Math.max(...hooks.map(h => h.timeout), 0);
const drainTimeout = maxTimeout + 1000; // 1s grace period

// In finally:
await Promise.race([
  Promise.allSettled([...inflight]),
  new Promise<void>((r) => { const t = setTimeout(r, drainTimeout); t.unref(); }),
]);
```

This ensures the drain waits long enough for the slowest hook to complete (up to its own timeout).

### 2. Wrap per-PRD section in `runQueue` with try/finally

**File**: `src/engine/eforge.ts`, `runQueue()` method around lines 614-680

Wrap the per-PRD compile+build logic in a `try/catch/finally` that guarantees `session:end`:

```typescript
yield { type: 'session:start', sessionId: prdSessionId, ... };

let prdResult: EforgeResult = { status: 'failed', summary: 'Session terminated abnormally' };
try {
  // compile + build logic (existing code moved here)
  prdResult = { status: buildFailed ? 'failed' : 'completed', ... };
} catch (err) {
  prdResult = { status: 'failed', summary: (err as Error).message };
} finally {
  try { await updatePrdStatus(prd.filePath, prdResult.status); } catch {}
  yield { type: 'session:end', sessionId: prdSessionId, result: prdResult, ... };
}
yield { type: 'queue:prd:complete', prdId: prd.id, status: prdResult.status };
```

### 3. Move pre-try code inside try blocks in `compile()` and `build()`

**File**: `src/engine/eforge.ts`

Move `validatePlanSetName`, `createTracingContext`, and `tracing.setInput()` inside the `try` block in both methods. Use `let tracing` declared before try, assigned inside. This ensures `phase:end` is always emitted from the `finally` block even if validation or tracing setup fails.

## Scope

**In scope:**
- `src/engine/hooks.ts` - drain timeout derivation in `withHooks`
- `src/engine/eforge.ts` - `runQueue()` session lifecycle wrapper, `compile()` and `build()` pre-try code relocation
- New test in `test/hooks.test.ts` verifying drain timeout derives from hook config

**Out of scope:**
- N/A

## Acceptance Criteria

- `pnpm type-check` passes with no type errors
- `pnpm test` - all existing tests pass
- The drain timeout in `withHooks` is derived from the maximum configured hook timeout (not hardcoded), with a 1-second grace period
- A test in `test/hooks.test.ts` verifies that the drain timeout derives from hook config
- In queue mode (`runQueue`), `session:end` is guaranteed to fire via `try/finally` even if `compile()`, `build()`, or `updatePrdStatus()` throws
- In `compile()` and `build()`, `validatePlanSetName()`, `createTracingContext()`, and `tracing.setInput()` are inside the `try` block so `phase:end` is always emitted from the `finally` block
- Manual verification: `eforge run` with a failing build confirms the `session:end` hook fires and completes

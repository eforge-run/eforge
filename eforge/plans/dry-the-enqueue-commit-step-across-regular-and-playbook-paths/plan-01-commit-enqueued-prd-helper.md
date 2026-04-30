---
id: plan-01-commit-enqueued-prd-helper
name: Add commitEnqueuedPrd helper and adopt at both enqueue paths
branch: dry-the-enqueue-commit-step-across-regular-and-playbook-paths/commit-enqueued-prd-helper
---

# Add commitEnqueuedPrd helper and adopt at both enqueue paths

## Architecture Context

Two enqueue paths exist in the daemon and they have diverged on whether they commit the queue file:

- **Regular enqueue** — `POST /api/enqueue` spawns a subprocess that runs `eforge enqueue` → `EforgeEngine.enqueue()` (`packages/engine/src/eforge.ts:359-468`). The subprocess is justified: it runs the formatter and dependency-detector LLM agents and streams `enqueue:start`/`enqueue:complete` events. After `enqueuePrd()` returns, the engine inlines `git add` + `forgeCommit` at `eforge.ts:446-455`.
- **Playbook enqueue** — `POST /api/playbook/enqueue` (`packages/monitor/src/server.ts:1506-1518`) calls `enqueuePrd()` directly in-process. In-process is justified: playbooks pre-supply formatted content + an explicit `afterQueueId`, no LLM agents are needed, and the `/eforge:playbook` skill UX depends on a synchronous `validateDependsOnExists` + response. This path never commits — the queue file lands untracked.

The legitimate divergence (subprocess vs in-process) stays. The illegitimate divergence is that the trivial write-and-commit step has two implementations — one inline in the engine, one missing entirely on the daemon HTTP path.

A latent bug compounds the gap: `eforge.ts:448` calls `forgeCommit` without a `paths` argument, so any pre-staged user changes get swept into the `enqueue(...)` commit. The codebase pattern at `prd-queue.ts:292` (`cleanupCompletedPrd`) shows the right shape — `forgeCommit(cwd, msg, { paths: [filePath] })`.

`enqueuePrd()` itself stays a pure file-I/O function — its contract at `prd-queue.ts:561-570` ("Pure file I/O — no agent calls, no events") is load-bearing for `test/prd-queue-enqueue.test.ts`, `test/queue-piggyback.test.ts`, and for `recovery/apply.ts:94`, which uses a different commit message and threads a `modelTracker`. We do not fold commit logic into it.

## Implementation

### Overview

Add one helper, `commitEnqueuedPrd(filePath, prdId, title, cwd)`, to `packages/engine/src/prd-queue.ts` next to `cleanupCompletedPrd`. Replace the inline three-line `git add` + `forgeCommit` block at `eforge.ts:446-455` with a call to the helper (preserving the surrounding `try/catch` that yields `enqueue:commit-failed`). Add a call to the helper in `server.ts:1506-1518` immediately after `enqueuePrd()` resolves, inside the existing `try` at lines 1496-1526. Extend the existing `POST /api/playbook/enqueue` test in `test/playbook-api.test.ts` to assert the resulting commit message and a clean queue dir.

### Key Decisions

1. **Helper lives in `prd-queue.ts` next to `cleanupCompletedPrd`.** The two are parallel patterns: one removes a queue file with `git rm` + `forgeCommit`, the other adds one with `git add` + `forgeCommit`. Imports `forgeCommit`, `retryOnLock`, and `composeCommitMessage` are already present in this file (`prd-queue.ts:15-16`), so no import surgery is needed.
2. **Helper takes `(filePath, prdId, title, cwd)`, not the whole `EnqueuePrdResult`.** Both call sites already destructure `filePath` and `id` and have `title` in scope; passing primitives keeps the helper from depending on the result-object shape and matches the parallel `cleanupCompletedPrd(filePath, queueDir, cwd)` signature.
3. **`paths: [filePath]` scopes the commit.** This fixes the latent bug in `eforge.ts:448`, where the missing `paths` argument lets pre-staged user changes get swept into the enqueue commit. `prd-queue.ts:292` is the canonical pattern.
4. **Playbook commit failures surface as the existing 500 response.** The route's existing `try/catch` at `server.ts:1519-1526` already maps a thrown error to a 500 (or 404 for `/not found/i`). A commit failure is a hard failure — loud failure is the correct semantic, and the queue file stays on disk so the operation is idempotent (`git add` on an already-tracked unchanged file is a no-op).
5. **No new event from the playbook route.** The "engine emits, consumers render" rule stays intact: the subprocess path keeps emitting `enqueue:*` events; the in-process route returns `{ id }` and stays event-free. The recorder (`packages/monitor/src/recorder.ts:52,107`) and session finalizer (`packages/engine/src/session.ts:111`) only consume from the subprocess path.
6. **`enqueuePrd()` is not modified.** Its "Pure file I/O — no agent calls, no events" contract (`prd-queue.ts:561-570`) is preserved so existing tests and the recovery path keep working unchanged.
7. **Recovery path stays untouched.** `packages/engine/src/recovery/apply.ts:94-111` uses a different commit message (`recover(${prdId}): enqueue successor ...`) and threads a `modelTracker`. Folding it in would force the helper to take a message-builder, undoing the simplicity. Leave it.
8. **Pi extension parity.** Pi calls the daemon HTTP route at `packages/pi-eforge/extensions/eforge/playbook-commands.ts:336`, so the fix flows through automatically. No Pi-side change.

## Scope

### In Scope
- New `commitEnqueuedPrd(filePath, prdId, title, cwd)` helper in `packages/engine/src/prd-queue.ts`, placed immediately after `cleanupCompletedPrd` (~line 293).
- Refactor of `packages/engine/src/eforge.ts:446-455` to call the new helper, preserving the surrounding `try/catch` that yields `enqueue:commit-failed`. Add `commitEnqueuedPrd` to the existing `prd-queue` import (currently `enqueuePrd` etc.) at the top of the file, and remove now-unused imports if any.
- Update of `packages/monitor/src/server.ts:1506-1518` to call the new helper after `enqueuePrd`, inside the existing `try` block at lines 1496-1526. Add `commitEnqueuedPrd` to the dynamic import at line 1481.
- Latent bug fix: scope the regular-path commit with `paths: [filePath]` (delivered automatically by routing through the helper).
- Test addition in `test/playbook-api.test.ts` asserting commit message and clean queue dir after `POST /api/playbook/enqueue`.

### Out of Scope
- Changing the subprocess vs in-process split between the two enqueue paths — it stays exactly as it is.
- Modifying `enqueuePrd()` itself — its "Pure file I/O — no agent calls, no events" contract at `prd-queue.ts:561-570` is preserved.
- Touching the recovery path at `packages/engine/src/recovery/apply.ts:94-111` (different commit message, threads a `modelTracker`).
- Pi-side changes — Pi calls the daemon HTTP route at `packages/pi-eforge/extensions/eforge/playbook-commands.ts:336` and inherits the fix.
- Emitting any new event from the playbook route — the in-process route returns `{ id }` and stays event-free.
- Changes to other call sites of `forgeCommit` or other queue helpers.

## Files

### Create
_None._

### Modify
- `packages/engine/src/prd-queue.ts` — add the `commitEnqueuedPrd(filePath, prdId, title, cwd)` helper immediately after `cleanupCompletedPrd` (~line 293). Implementation:
  ```ts
  /**
   * Stage and commit a freshly enqueued PRD file.
   *
   * Used by both enqueue paths (engine subprocess and daemon HTTP playbook route)
   * to keep the write-and-commit step in one place. `paths: [filePath]` scopes the
   * commit so any unrelated staged changes in the working tree are not swept in.
   */
  export async function commitEnqueuedPrd(
    filePath: string,
    prdId: string,
    title: string,
    cwd: string,
  ): Promise<void> {
    await retryOnLock(() => exec('git', ['add', '--', filePath], { cwd }), cwd);
    await forgeCommit(
      cwd,
      composeCommitMessage(`enqueue(${prdId}): ${title}`),
      { paths: [filePath] },
    );
  }
  ```
  - `--` after `git add` matches the style at `prd-queue.ts:286, 311`.
  - All needed imports (`forgeCommit`, `retryOnLock`, `composeCommitMessage`, `exec`) are already present in this file.

- `packages/engine/src/eforge.ts` — replace lines 446-455 to call the new helper while preserving the streaming `enqueue:commit-failed` event:
  - Replace the body of the inner `try`:
    ```ts
    await retryOnLock(() => exec('git', ['add', enqueueResult.filePath], { cwd }), cwd);
    await forgeCommit(cwd, composeCommitMessage(`enqueue(${enqueueResult.id}): ${title}`));
    ```
    with:
    ```ts
    await commitEnqueuedPrd(enqueueResult.filePath, enqueueResult.id, title, cwd);
    ```
  - Add `commitEnqueuedPrd` to the existing import from `./prd-queue.js` near the top of the file. If `retryOnLock` and/or `composeCommitMessage` are no longer referenced in `eforge.ts` after this change, drop them from the imports (they remain at lines 55-56 today; verify against the rest of the file before removing).
  - Do **not** alter the surrounding `try`/`catch` block that yields the `enqueue:commit-failed` event — that streaming behavior is what the subprocess path needs.

- `packages/monitor/src/server.ts` — update the playbook enqueue route at lines 1506-1518:
  - Add `commitEnqueuedPrd` to the dynamic import at line 1481, so it reads:
    ```ts
    const { enqueuePrd, inferTitle, validateDependsOnExists, commitEnqueuedPrd } = await import('@eforge-build/engine/prd-queue');
    ```
  - Immediately after the `await enqueuePrd({ ... })` call (currently ending at line 1517), inside the existing `try` (lines 1496-1526) and before the `sendJson(res, { id: result.id })` at line 1518, add:
    ```ts
    await commitEnqueuedPrd(result.filePath, result.id, title, cwd);
    ```
  - Leave the existing `catch` at lines 1519-1526 unchanged. A commit failure flows through the same 500 response path the route already uses (or 404 if `/not found/i` matches, which is not expected for commit failures).

- `test/playbook-api.test.ts` — extend the existing test `it('creates a PRD in the queue dir and returns its id', ...)` (currently at line 289) so that after the route returns 200 it also asserts:
  1. `git log -1 --pretty=%s` (run with `cwd: tmpDir` via `execFileSync`) starts with `enqueue(${data.id}): ` (the title is whatever `inferTitle` produces from the playbook source — assert the prefix, not the full string, to avoid coupling to that derivation).
  2. `git status --porcelain eforge/queue/` (run with `cwd: tmpDir`) returns an empty string — i.e., the queue directory is clean after the route returns.
  - The existing `setupProject` helper at lines 33-48 already runs `git init`, configures user, and creates an initial empty commit, so no test-fixture churn is needed.
  - Optionally extend the same assertion to the `it('persists dependsOn in PRD frontmatter when afterQueueId is provided', ...)` test (line 317) if it can be done without restructuring — both predecessor and dependent enqueues should land as commits and leave a clean working tree. If that adds complexity, restrict the new assertions to the simpler test.

## Verification

- [ ] `pnpm type-check` exits 0.
- [ ] `pnpm test` exits 0, including:
  - [ ] `test/playbook-api.test.ts` — the existing `creates a PRD in the queue dir and returns its id` test additionally asserts that `git log -1 --pretty=%s` (run in the test's tmp dir) starts with `enqueue(<id>): `.
  - [ ] `test/playbook-api.test.ts` — the same test additionally asserts that `git status --porcelain eforge/queue/` (run in the test's tmp dir) returns an empty string after the route returns.
  - [ ] `test/prd-queue-enqueue.test.ts` passes unchanged (no edits required; `enqueuePrd` contract is unmodified).
  - [ ] `test/queue-piggyback.test.ts` passes unchanged.
- [ ] `packages/engine/src/prd-queue.ts` exports `commitEnqueuedPrd` with signature `(filePath: string, prdId: string, title: string, cwd: string) => Promise<void>`.
- [ ] `packages/engine/src/prd-queue.ts` `commitEnqueuedPrd` body invokes `forgeCommit` with `{ paths: [filePath] }` (verify by file inspection — the third argument literal contains `paths: [filePath]`).
- [ ] `packages/engine/src/eforge.ts` no longer contains the literal string `git add` `enqueueResult.filePath` adjacent call followed by a separate `forgeCommit` call in the enqueue method (lines 446-455 region) — replaced by a single `await commitEnqueuedPrd(...)` call inside the existing `try`/`catch` that yields `enqueue:commit-failed`.
- [ ] `packages/engine/src/eforge.ts` enqueue method still yields an `enqueue:commit-failed` event when the helper throws (verify by file inspection — the `try`/`catch` around the helper call is preserved, the `catch` body still yields `{ type: 'enqueue:commit-failed', error: ... }`).
- [ ] `packages/monitor/src/server.ts` line 1481 dynamic import destructures `commitEnqueuedPrd` from `@eforge-build/engine/prd-queue`.
- [ ] `packages/monitor/src/server.ts` calls `commitEnqueuedPrd(result.filePath, result.id, title, cwd)` immediately after the `await enqueuePrd({ ... })` call and before `sendJson(res, { id: result.id })`, inside the existing `try` block.
- [ ] `packages/engine/src/recovery/apply.ts` lines 94-111 are unchanged (recovery path keeps its distinct commit message and `modelTracker`).
- [ ] `packages/engine/src/prd-queue.ts` `enqueuePrd` function (lines 561+) is unchanged in behavior — it still performs only file I/O, no `git add` or `forgeCommit`.
- [ ] Manual end-to-end check: after `pnpm build` and a daemon restart, invoking `mcp__eforge__eforge_playbook { action: "enqueue", name: "<some-playbook>" }` produces a commit whose subject matches `enqueue(<slug>): ...` and leaves `git status --porcelain eforge/queue/` empty.
- [ ] Manual regression check on the regular path: with an unrelated file staged (`git add <unrelated-file>`), running `eforge enqueue "test prd"` produces an `enqueue(...)` commit that contains only the new queue file, not the unrelated staged change.

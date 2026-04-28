---
title: Fix recovery split successor PRD spurious "blocked by" dependency
created: 2026-04-28
---

# Fix recovery split successor PRD spurious "blocked by" dependency

## Problem / Motivation

When a build fails and the user applies a `split` recovery verdict (via `eforge_apply_recovery` MCP / `/recover`), the engine writes a **successor PRD** into the queue. In the user's project at `~/projects/ytc/member-portal/`, the monitor UI showed:

- New successor PRD `wave-e-api-route-migration-eslint-enforcement.md` listed as **"blocked by: server-action-contract-guardrail-library"** — i.e., blocked by the failed PRD it was created to replace.
- The failed PRD itself shown with **"blocked by: timezone-compliance-sweep"** even though `timezone-compliance-sweep` already completed and is no longer in the queue.

This is misleading: a successor PRD is conceptually **independent** of the failed PRD it replaces (the failed one moves to `failed/` as the audit trail and is not pending). And a terminal/failed PRD shouldn't render a "blocked by" line at all.

### Root cause (verified end-to-end)

The successor PRD's frontmatter on disk contains `depends_on: ["server-action-contract-guardrail-library"]` — that text was emitted by the recovery analyst LLM and persisted verbatim. Two compounding problems:

1. **Recovery split bypasses the normal enqueue pipeline.** `applyRecoverySplit` in `packages/engine/src/recovery/apply.ts:130-158` writes `verdict.suggestedSuccessorPrd` directly via `writeFile` (line 144). The normal enqueue flow (`EforgeEngine.enqueue` at `packages/engine/src/eforge.ts:370-436`) generates clean frontmatter via `enqueuePrd` (`packages/engine/src/prd-queue.ts:563`) after running formatter + dependency-detector — that flow is skipped here. The recovery analyst prompt (`packages/engine/src/prompts/recovery-analyst.md`) shows an example successor without frontmatter but doesn't forbid it; the LLM pattern-matched the original PRD's frontmatter and copied a (semantically reasonable but operationally wrong) `depends_on` referencing the failed PRD.

2. **Monitor UI surfaces `dependsOn` verbatim with no filtering.** The engine's `resolveQueueOrder` at `packages/engine/src/prd-queue.ts:190` correctly filters `depends_on` entries to those still in the queue (so the successor would actually run autonomously). But the daemon's `serveQueue` at `packages/monitor/src/server.ts:716` exposes the raw frontmatter list, and the UI at `packages/monitor-ui/src/components/layout/queue-section.tsx:257-261` renders it. UI-truth and runtime-truth diverge.

Confirmed on disk:
```yaml
# /Users/markschaake/projects/ytc/member-portal/eforge/queue/wave-e-api-route-migration-eslint-enforcement.md
title: "Server Action Contract — Wave E: API Routes + ESLint Enforcement"
depends_on: ["server-action-contract-guardrail-library"]   # the failed PRD
```

## Goal

Ensure successor PRDs created by the `split` recovery verdict do not carry spurious `depends_on` references to the failed PRD they replace, and ensure the monitor UI's "blocked by" display mirrors the engine's runtime dependency semantics so it never lies about terminal or stale dependencies.

## Approach

Fix in two layers — recovery-side (eliminate the source) plus server-side (mirror runtime semantics so UI never lies).

### Layer A — `applyRecoverySplit`: route the successor through `enqueuePrd`

Treat the agent's `suggestedSuccessorPrd` as **body content only**. Strip any frontmatter the agent emitted, derive the title from the body's H1, and let `enqueuePrd` build clean frontmatter from scratch with `depends_on: []`. Reasons:

- `enqueuePrd` (`packages/engine/src/prd-queue.ts:563`) is the canonical pure-I/O writer for queue PRDs. It already handles slug derivation, collision suffixing, and frontmatter construction. Reusing it removes a parallel implementation.
- We do **not** route through `EforgeEngine.enqueue` (the orchestrator) because that runs formatter + dependency-detector agents — extra cost, and the recovery analyst already produced a well-structured PRD body. Re-running dep-detection here could spuriously rebind the successor to other queue items based on text overlap.
- `loadQueue` only reads the queue dir (not `failed/`), so even if we ever did run dep-detection later, the failed PRD couldn't be picked as a candidate. No additional guard needed.

### Layer B — `serveQueue`: filter stale dependencies

After loading queue + failed + skipped, post-process `items` so the API mirrors what the engine actually does at runtime:

- For items whose status is `failed` or `skipped`, drop `dependsOn` entirely (terminal items aren't waiting on anything).
- For items whose status is `pending` or `running`, retain only `dependsOn` entries whose IDs match a `pending` or `running` item in the same response. Drop the field if empty.

UI stays dumb — no change in `queue-section.tsx`.

### Layer C — defense-in-depth prompt nudge

Add one sentence to the recovery analyst prompt telling the model to emit body only, no frontmatter. Code is the contract; the prompt just reduces noise on the wire.

### Changes

#### `packages/engine/src/recovery/apply.ts`

- Add imports: `enqueuePrd`, `inferTitle` from `../prd-queue.js`.
- Replace `applyRecoverySplit` body (lines 130–158):
  - Strip leading frontmatter from `verdict.suggestedSuccessorPrd`:
    ```ts
    const body = verdict.suggestedSuccessorPrd
      .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
      .replace(/^\s+/, '');
    ```
  - `const title = inferTitle(body);`
  - `const { id: successorPrdId, filePath: successorPath } = await enqueuePrd({ body, title, queueDir, cwd, depends_on: [] });`
  - Keep the existing `git add successorPath` + `forgeCommit` flow.
- Delete `deriveSuccessorPrdId` (lines 33–86) — no other callers (verified via repo-wide grep).
- Update the JSDoc on `applyRecoverySplit` (currently references `deriveSuccessorPrdId` at line 128).

#### `packages/monitor/src/server.ts`

- In `serveQueue` (lines 664–732), after `Promise.all([...loadFromDir...])` and before `sendJson(res, items)`:
  ```ts
  const liveIds = new Set(
    items.filter((i) => i.status === 'pending' || i.status === 'running').map((i) => i.id),
  );
  for (const item of items) {
    if (item.status === 'failed' || item.status === 'skipped') {
      delete item.dependsOn;
    } else if (item.dependsOn) {
      const filtered = item.dependsOn.filter((dep) => liveIds.has(dep));
      if (filtered.length === 0) delete item.dependsOn;
      else item.dependsOn = filtered;
    }
  }
  ```

#### `packages/engine/src/prompts/recovery-analyst.md`

- Insert a single line near the `<suggestedSuccessorPrd>` example (around line 87, immediately before the example block):

  > Emit the PRD body only — do not include YAML frontmatter (`--- … ---`). The system writes frontmatter automatically.

### Tests

**`test/apply-recovery.test.ts`** (existing assertions at lines 222, 225, 228, 244, 252, 270 should still pass — `enqueuePrd`'s slugify produces the same output as the deleted `deriveSuccessorPrdId`):

- Add a new test case: seed a `split` verdict whose `suggestedSuccessorPrd` begins with a malicious frontmatter block:
  ```
  ---
  title: Wrong Title
  depends_on: ["the-failed-prd-id"]
  ---

  # Real Title

  body…
  ```
  Assert: (a) successor file's frontmatter has `title: Real Title` and **no** `depends_on:` line, (b) `successorPrdId === 'real-title'`, (c) `body` content does not contain a leading `---`.

**`packages/monitor/test/`** (or wherever the existing server tests live — verify path during implementation):

- Add a `serveQueue` test: stage a queue with one `pending` item depending on `[unknown-id, another-pending-id]` and one `failed` item with `depends_on: [some-id]`. Assert the response strips the unknown id from the pending item and removes `dependsOn` entirely from the failed item.

### Critical files

- `packages/engine/src/recovery/apply.ts` — main fix
- `packages/engine/src/prd-queue.ts` — `enqueuePrd` (reused), `inferTitle` (reused) — no edits
- `packages/engine/src/prompts/recovery-analyst.md` — prompt nudge
- `packages/monitor/src/server.ts` — `serveQueue` post-filter
- `test/apply-recovery.test.ts` — extend coverage
- (server test file for `serveQueue` — locate during implementation)

## Scope

### In scope

- Layer A: rewrite `applyRecoverySplit` in `packages/engine/src/recovery/apply.ts` to route the successor PRD through `enqueuePrd`, stripping any agent-emitted frontmatter and deriving the title via `inferTitle`. Delete the now-unused `deriveSuccessorPrdId`. Update related JSDoc.
- Layer B: post-filter `serveQueue` in `packages/monitor/src/server.ts` so terminal items expose no `dependsOn` and live items expose only `dependsOn` IDs that match other pending/running items in the same response.
- Layer C: add a single line to `packages/engine/src/prompts/recovery-analyst.md` instructing the model to emit body only with no YAML frontmatter.
- Extend `test/apply-recovery.test.ts` with the malicious-frontmatter case described above.
- Add a `serveQueue` filtering test in the monitor server test suite (path to be located during implementation).

### Out of scope

- Allowing the recovery analyst to declare *legitimate* dependencies on other pending PRDs in the successor. Today the recovery analyst is given the failed PRD + failure summary only — it has no view of the broader queue, so it has no basis to declare cross-PRD deps. If we later want this capability, the right design is to feed `loadQueue` results into the recovery prompt context and have the agent explicitly emit a `<dependsOn>` field — a separate, larger change.
- Migrating existing on-disk successor PRDs that already carry the bad `depends_on`. The Layer B filter masks them in the UI; rewriting their frontmatter is a one-off cleanup the user can do manually if desired.
- Changes to `eforge-plugin/` or `packages/pi-eforge/` — both call `eforge_apply_recovery` / engine `applyRecovery`, which sit above `applyRecoverySplit`; verify via grep that neither calls `applyRecoverySplit` directly (should be none).
- Changes to `packages/monitor-ui/src/components/layout/queue-section.tsx` — UI stays dumb.

## Acceptance Criteria

1. **Unit tests pass** — `pnpm test` in repo root (vitest); the new frontmatter-stripping test and the `serveQueue` filter test pass alongside the existing recovery suite. Existing assertions in `test/apply-recovery.test.ts` at lines 222, 225, 228, 244, 252, 270 continue to pass.
2. **Type check passes** — `pnpm type-check`.
3. **Build succeeds** — `pnpm build` so the daemon picks up changes; restart via the `eforge-daemon-restart` skill (per memory: check active builds first).
4. **`applyRecoverySplit` behavior** — given a `split` verdict whose `suggestedSuccessorPrd` begins with a YAML frontmatter block (including `depends_on` referencing the failed PRD):
   - The successor file's frontmatter contains `title: <H1 from body>` and **no** `depends_on:` line.
   - `successorPrdId` matches the slugified H1 title (e.g., `real-title` for `# Real Title`).
   - The persisted body content does not contain a leading `---`.
   - The existing `git add successorPath` + `forgeCommit` flow remains intact.
5. **`deriveSuccessorPrdId` removed** — function deleted from `packages/engine/src/recovery/apply.ts`; no references remain in the repo.
6. **`serveQueue` filtering** — given a queue with one `pending` item depending on `[unknown-id, another-pending-id]` and one `failed` item with `depends_on: [some-id]`:
   - The response strips `unknown-id` from the pending item's `dependsOn`, retaining only `another-pending-id`.
   - The response removes `dependsOn` entirely from the failed item.
   - `pending`/`running` items whose filtered `dependsOn` becomes empty have the field dropped.
7. **Recovery analyst prompt** — `packages/engine/src/prompts/recovery-analyst.md` contains the new line near the `<suggestedSuccessorPrd>` example (around line 87, immediately before the example block) instructing the model to emit body only without YAML frontmatter.
8. **End-to-end on `~/projects/ytc/member-portal`** — for new failures: trigger a failure → run `/recover` with `split` → confirm the new successor PRD's on-disk frontmatter contains no `depends_on`, and the monitor UI shows it without a "blocked by" line. The pre-existing legacy successor `wave-e-api-route-migration-eslint-enforcement.md` either is manually edited to remove `depends_on: ["server-action-contract-guardrail-library"]`, or is masked in the UI by the Layer B server-side filter.
9. **Cross-consumer sanity** — neither `eforge-plugin/` nor `packages/pi-eforge/` require changes; grep confirms no direct calls to `applyRecoverySplit` in either.

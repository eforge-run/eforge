---
id: plan-01-fix-spurious-depends-on
name: Fix spurious depends_on on split-recovery successor PRDs
branch: fix-recovery-split-successor-prd-spurious-blocked-by-dependency/plan-01
---

# Fix spurious depends_on on split-recovery successor PRDs

## Architecture Context

The `split` recovery verdict (`eforge_apply_recovery` MCP / `/recover`) currently writes the agent's `suggestedSuccessorPrd` directly to the queue via `writeFile`, bypassing the canonical `enqueuePrd` writer. The recovery analyst LLM has been observed copying the failed PRD's frontmatter — including a `depends_on` referencing the failed PRD — into the successor body. The monitor UI then renders that raw `dependsOn` as a "blocked by" line, even though the engine's runtime `resolveQueueOrder` (`packages/engine/src/prd-queue.ts:177`) already filters dead deps when scheduling.

This plan closes both gaps in one cohesive change:

- **Layer A — recovery side:** route the successor through `enqueuePrd`, treating the agent output as body only and rebuilding clean frontmatter with `depends_on: []`. We deliberately do NOT route through `EforgeEngine.enqueue` (which runs formatter + dependency-detector agents) — the recovery analyst already produces well-structured PRD bodies, and re-running dep-detection could spuriously rebind the successor based on text overlap.
- **Layer B — monitor side:** post-filter the `/api/queue` response so terminal items (`failed`, `skipped`) expose no `dependsOn`, and live items (`pending`, `running`) expose only `dependsOn` IDs that match other live items in the same response. This mirrors `resolveQueueOrder`'s runtime semantics so UI-truth and runtime-truth converge — the UI stays dumb.
- **Layer C — prompt nudge:** add one sentence to `recovery-analyst.md` instructing the model to emit body only with no YAML frontmatter. Code is the contract; the prompt just reduces noise on the wire.

The two upstream callers — `eforge-plugin/` and `packages/pi-eforge/` — both go through `engine.applyRecovery` -> `applyRecoverySplit`, so neither needs changes (verified via repo-wide grep yielding zero direct callers of `applyRecoverySplit` in either package).

## Implementation

### Overview

Four files change. One function is deleted; one is rewritten to delegate to `enqueuePrd`; one server function gets a 10-line post-filter; one prompt gets one sentence; two test files gain coverage.

### Key Decisions

1. **Reuse `enqueuePrd` (`packages/engine/src/prd-queue.ts:563`) rather than `EforgeEngine.enqueue`.** `enqueuePrd` is the pure-I/O writer with slug derivation, collision suffixing, and frontmatter construction. The orchestrator-level `enqueue` runs formatter + dependency-detector agents — extra cost and a real risk of spuriously reattaching the successor to other queue items via text overlap. The recovery analyst's body is already structured.
2. **Strip leading frontmatter with `/^---\r?\n[\s\S]*?\r?\n---\r?\n?/` then trim leading whitespace.** This is a single regex pass: tolerant of `\r\n`, non-greedy, anchored to file start. If the body has no frontmatter the regex no-ops.
3. **Delete `deriveSuccessorPrdId` outright (no compat shim).** Per project memory `feedback_no_backward_compat`: rip out replaced code cleanly. `enqueuePrd`'s `slugify` produces identical output for the existing test cases (`Successor Feature` -> `successor-feature`, `REST API Layer` -> `rest-api-layer`), so existing assertions continue to hold. The pre-existing collision behavior shifts subtly (`enqueuePrd` uses numeric suffixes starting at `-2`, `deriveSuccessorPrdId` starts at `-1`) but the failed PRD is in `failed/` (not `queueDir`), so the failed ID can never collide with a successor written to `queueDir` — the `failedPrdId` exclusion in the deleted function was defensive against a scenario that cannot occur.
4. **Server filter operates on the response array post-load, not at the per-file level.** This lets us cross-reference `pending`/`running` IDs to filter `dependsOn` entries pointing at completed (i.e., not-in-response) PRDs. We mutate `item` in place with `delete item.dependsOn` and reassignment — the `QueueItem` type already has `dependsOn` as optional.
5. **Prompt update placement: immediately before the `<suggestedSuccessorPrd>` example block (around line 87).** The example is what the model pattern-matches on; the instruction must sit adjacent so it's contextually anchored. Per project memory `feedback_no_tools_in_prompts`: the instruction stays harness-agnostic — talks about "body only" and "the system writes frontmatter automatically" without naming any tool.

## Scope

### In Scope

- Rewrite `applyRecoverySplit` in `packages/engine/src/recovery/apply.ts` to strip frontmatter, derive title via `inferTitle`, and call `enqueuePrd` with `depends_on: []`. Preserve the `git add successorPath` + `forgeCommit` + `git rev-parse HEAD` flow.
- Delete `deriveSuccessorPrdId` (lines 33-86) and update the JSDoc on `applyRecoverySplit` to remove the reference to it.
- Post-filter `serveQueue` in `packages/monitor/src/server.ts` (after the `Promise.all` load, before `sendJson`) so terminal items drop `dependsOn` entirely and live items retain only deps that match other live items. Drop the field when filtered list is empty.
- Insert a single instruction line into `packages/engine/src/prompts/recovery-analyst.md` immediately before the `<suggestedSuccessorPrd>` example: "Emit the PRD body only - do not include YAML frontmatter (`--- ... ---`). The system writes frontmatter automatically."
- Extend `test/apply-recovery.test.ts` with a new test that seeds a `split` verdict whose `suggestedSuccessorPrd` begins with a frontmatter block containing `depends_on: ["the-failed-prd-id"]` and a wrong `title`. Assert: (a) successor file's frontmatter has `title: Real Title` and no `depends_on:` line; (b) `successorPrdId === 'real-title'`; (c) persisted body content does not begin with `---`.
- Add a new test file `test/serve-queue-depends-on-filter.test.ts` covering `serveQueue`'s filter behavior. Approach: start the monitor server via `startServer` against a temp `cwd` with a seeded queue (one `pending` item with `depends_on: [unknown-id, another-pending-id]`, one `pending` item `another-pending-id`, one `failed` item with `depends_on: [some-id]`). Fetch `/api/queue` over HTTP. Assert: pending item retains only `another-pending-id`; failed item has no `dependsOn` field; pending items whose filtered list becomes empty drop the field.

### Out of Scope

- Routing through `EforgeEngine.enqueue` (orchestrator path with formatter/dep-detector agents) — too costly and risks spurious dep-rebinding.
- Allowing the recovery analyst to declare legitimate cross-PRD dependencies — would require feeding `loadQueue` into the recovery prompt context; separate, larger change per source PRD.
- Migrating existing on-disk successors that already carry the bad `depends_on` (e.g. `wave-e-api-route-migration-eslint-enforcement.md` in the user's `~/projects/ytc/member-portal/`). Layer B masks them at the API; rewriting their frontmatter is a one-off the user can do manually.
- Changes to `eforge-plugin/` or `packages/pi-eforge/` — neither calls `applyRecoverySplit` directly (verified via repo-wide grep).
- Changes to `packages/monitor-ui/src/components/layout/queue-section.tsx` — UI stays dumb.

## Files

### Create

- `test/serve-queue-depends-on-filter.test.ts` - vitest covering `serveQueue`'s post-load filter using a real `startServer` instance against a temp queue dir. Uses a real HTTP fetch against the bound port; tears down via `monitorServer.stop()`.

### Modify

- `packages/engine/src/recovery/apply.ts`:
  - Add `import { enqueuePrd, inferTitle } from '../prd-queue.js';`.
  - Remove the now-unused `readdir` import (it was only used by `deriveSuccessorPrdId`); confirm `writeFile` is also no longer needed and remove from the `node:fs/promises` import.
  - Delete `deriveSuccessorPrdId` (lines 33-86) including its JSDoc.
  - Rewrite the body of `applyRecoverySplit` (currently lines 130-158): replace the `deriveSuccessorPrdId` -> `writeFile` -> `git add` block with:
    1. `const body = verdict.suggestedSuccessorPrd.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').replace(/^\s+/, '');`
    2. `const title = inferTitle(body);`
    3. `const { id: successorPrdId, filePath: successorPath } = await enqueuePrd({ body, title, queueDir, cwd, depends_on: [] });`
    4. Keep the existing `retryOnLock(() => exec('git', ['add', '--', successorPath], { cwd }), cwd)` and the `composeCommitMessage` + `forgeCommit` + `git rev-parse HEAD` block unchanged.
  - Update the JSDoc on `applyRecoverySplit` to remove the line `Successor ID derivation: see deriveSuccessorPrdId.` and replace with a one-line note that the agent's `suggestedSuccessorPrd` is treated as body only and routed through `enqueuePrd`.

- `packages/monitor/src/server.ts`:
  - In `serveQueue` (currently lines 664-732), after the `await Promise.all([...loadFromDir...])` and before `sendJson(res, items)`, insert:
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
  - No change to the `QueueItem` type — `dependsOn` is already optional.

- `packages/engine/src/prompts/recovery-analyst.md`:
  - Insert one line immediately before the second example block (the one that begins with the prose intro `Example — split verdict with successor PRD:` at line 72, followed by the code fence at line 74 enclosing `<recovery verdict="split" confidence="high">`). The new line goes between the existing line 70 closing fence (end of the manual-verdict example) and line 72, as a standalone paragraph in the `## Output` section. Text:
    > Emit the PRD body only - do not include YAML frontmatter (`--- ... ---`). The system writes frontmatter automatically.
  - Rationale: the instruction must sit adjacent to the example the model pattern-matches on (the split-verdict example, which contains the `<suggestedSuccessorPrd>` element at line 88). Do NOT place it in the `## prd-completeness Rule for split` section — that section ends at line 49 (`{{partialHint}}`), too far from the example.

- `test/apply-recovery.test.ts`:
  - Add a new `it(...)` inside the existing `describe('applyRecovery - split', ...)` block. Name suggestion: `'strips agent-emitted frontmatter and rebuilds clean frontmatter with no depends_on'`.
  - Seed a split verdict whose `suggestedSuccessorPrd` is:
    ```
    ---
    title: Wrong Title
    depends_on: ["the-failed-prd-id"]
    ---
    
    # Real Title
    
    Body content here.
    ```
  - Assertions:
    - `result.successorPrdId === 'real-title'`.
    - The successor file at `eforge/queue/real-title.md` exists; its content has frontmatter starting with `title: Real Title`.
    - The successor file's content contains no `depends_on:` line (use a regex/substring check on the full file content).
    - The body section of the successor file (everything after the trailing `---` of the new frontmatter) does not begin with `---` (i.e. the agent's frontmatter was stripped before being passed as body).
  - Existing assertions at lines 222, 225, 228, 244, 252, 270 continue to pass — verified that `enqueuePrd`'s `slugify` produces `successor-feature` for `# Successor Feature` and `rest-api-layer` for `# REST API Layer`, matching the deleted `deriveSuccessorPrdId`.

## Verification

- [ ] `pnpm type-check` exits 0 from repo root.
- [ ] `pnpm build` exits 0 from repo root.
- [ ] `pnpm test` exits 0 from repo root; the new frontmatter-stripping test in `test/apply-recovery.test.ts` and the new `test/serve-queue-depends-on-filter.test.ts` both pass; existing assertions in `test/apply-recovery.test.ts` at lines 222, 225, 228, 244, 252, 270 continue to pass.
- [ ] `git grep -n 'deriveSuccessorPrdId' -- ':!eforge/queue' ':!eforge/plans'` returns zero matches in source/tests (PRD/plan markdown references are allowed).
- [ ] `git grep -n 'applyRecoverySplit' eforge-plugin/ packages/pi-eforge/` returns zero matches.
- [ ] In `packages/engine/src/recovery/apply.ts`, `applyRecoverySplit` no longer calls `writeFile` and instead calls `enqueuePrd` with `depends_on: []`.
- [ ] In `packages/monitor/src/server.ts`, `serveQueue` performs the post-load filter using a `liveIds` set built from `pending`/`running` items, deleting `dependsOn` from `failed`/`skipped` items and pruning unknown IDs from live items' `dependsOn` (dropping the field when filtered to empty).
- [ ] `packages/engine/src/prompts/recovery-analyst.md` contains the line instructing the model to emit body only without YAML frontmatter, placed adjacent to the `<suggestedSuccessorPrd>` example.
- [ ] Given a split verdict whose `suggestedSuccessorPrd` begins with a YAML frontmatter block containing `depends_on: ["the-failed-prd-id"]`: the on-disk successor file's frontmatter contains `title:` matching the body's H1 and contains zero `depends_on:` lines.
- [ ] Given a `serveQueue` request against a queue with one pending item depending on `[unknown-id, another-pending-id]` and one failed item with `depends_on: [some-id]`: the JSON response strips `unknown-id` from the pending item's `dependsOn` (retaining `another-pending-id`), and the failed item has no `dependsOn` field.

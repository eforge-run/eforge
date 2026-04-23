---
title: Fix builder continuation when committed work hits max_turns
created: 2026-04-23
---

# Fix builder continuation when committed work hits max_turns

## Problem / Motivation

Build `per-command-timeout-for-post-merge-validate-phase` failed with `error_max_turns: Reached maximum number of turns (80)` on plan-01, but the expected up-to-3-continuation handoff never fired — no `agent:retry` and no `build:implement:continuation` events in the run (verified in `.eforge/monitor.db`, run id `5d65f3de-06a7-4696-b837-a452f93d393d`).

Walking the event stream from that run pins down what happened:

1. Builder ran for ~15 min, 81 turns. The SDK cut it at max_turns on turn 81.
2. At `16:33:25.827Z` — four turns before the cut — the builder issued `git add <files> && git commit -m "feat(plan-01…)"` batching everything.
3. Next turns: `git log --oneline -3`, then `pnpm type-check`. Those read as "commit succeeded, now verifying". It ran out of turns during verification.
4. `agent:result` (numTurns 81) → SDK throws `AgentTerminalError('error_max_turns')`.
5. `builderImplement` catches, yields `build:failed` with `terminalSubtype: 'error_max_turns'` (confirmed in the stored event payload).
6. `withRetry` (`packages/engine/src/retry.ts:604`) detects the subtype, holds the event back, proceeds to call the policy's continuation builder.
7. **`buildBuilderContinuationInput` (`packages/engine/src/retry.ts:321-363`) calls `hasAnyChanges(worktreePath)` (`retry.ts:180`). Because the builder already committed on turn 77, the worktree is clean → returns `false` → the function throws `"Builder continuation aborted: no changes to checkpoint"`.**
8. `withRetry`'s catch at `retry.ts:656-662` swallows that error, yields the held-back `build:failed`, returns. No retry, no diagnostic.

The guard was written to prevent `forgeCommit` from crashing on an empty staging area (`packages/engine/src/git.ts:98` — `git commit` with nothing staged exits non-zero). But "clean worktree" conflates two cases:

- Truly no progress (what the guard intends to catch) → fail.
- Progress exists and is already committed (what happened here) → retry is still valid; the new builder should pick up verification from the committed state.

### Why the builder kept going after committing

The prompt at `packages/engine/src/prompts/builder.md` sets the order implement → verify → commit ("After all verification passes, create a single commit", line 50) but has **no explicit stop** after the commit step. In the failing run the agent did verify-then-commit correctly, then issued a trailing `git log --oneline -3` + a "Final type-check verification" (description taken from the agent's own tool-use input) — purely defensive turns the prompt never asked for, burning its remaining budget.

Two things are wrong and both should be fixed together:

1. **Prompt**: the builder should stop immediately after the single commit.
2. **Runtime**: even if the builder does overshoot and hits max_turns *after* committing, the continuation logic should recognize committed progress instead of silently aborting.

## Goal

Ensure that when a builder hits `error_max_turns` after it has already committed its work, the continuation handoff engages cleanly (picking up from the committed state), and that the builder prompt discourages the post-commit overshoot that created the situation in the first place. Silent aborts in the retry path are replaced with a visible diagnostic.

## Approach

### A. Prompt — make the commit terminal

Edit `packages/engine/src/prompts/builder.md`:

- Section header "## Commit" → "## Commit (last step — stop after this)".
- Under Constraints (around line 58), add:
  - "**Stop after commit** — the commit is the final action of this turn budget. Do not run additional verification, reads, greps, status checks, or 'double-check' operations after `git commit` succeeds. Verification belongs before the commit; anything after is wasted turns. Do not confirm the commit with `git log` — the orchestrator handles that."
- Body of the "## Commit" section: add a one-liner reinforcing the same point right next to the `git commit` template, so it's impossible to miss while composing the final response.

Keep the existing "No skipping verification" rule as-is — it already enforces verify-before-commit; we're only closing the "what happens after commit" gap.

### B. Runtime — fix `buildBuilderContinuationInput` (`packages/engine/src/retry.ts`)

In `buildBuilderContinuationInput` (`retry.ts:321-363`), replace the single `hasAnyChanges` guard with a three-way check:

```
hasUncommitted  = hasAnyChanges(worktreePath)                     // existing helper (retry.ts:180)
hasNewCommits   = (git rev-list --count ${baseBranch}..HEAD) > 0  // new inline exec
```

Branching:

- `hasUncommitted` → current behavior: `git add -A` + `forgeCommit` checkpoint, then build diff.
- `!hasUncommitted && hasNewCommits` → **new path**: skip the checkpoint commit, call `buildContinuationDiff` directly (it already diffs `baseBranch...HEAD`), return `{ kind: 'retry', input: … }` with the completed-diff context attached.
- `!hasUncommitted && !hasNewCommits` → preserve today's hard-fail semantics (no progress to continue from). Throw a descriptive error so the `withRetry` catch at `retry.ts:658` surfaces the held-back terminal event.

No schema changes to `BuilderContinuationInput` — `baseBranch` is already on the input (`retry.ts:294`).

### C. Stop the silent abort

Today, when `buildBuilderContinuationInput` throws, `withRetry`'s `retry.ts:656-662` catches with a bare `catch {}`. That is how the current failure became invisible — no event, no log.

Change that catch to emit a one-shot diagnostic before yielding the held-back terminal:

```
yield { type: 'agent:retry:aborted', agent, planId?, reason: (err as Error).message, … }
```

Add the event to the `EforgeEvent` union in `packages/engine/src/events.ts` and surface it in the monitor UI event renderer (same path as other agent retry events — consistent with the "Surface runtime agent decisions in monitor UI" feedback memory).

## Scope

### In scope

- `packages/engine/src/prompts/builder.md` — add "stop after commit" rule and rename the section header.
- `packages/engine/src/retry.ts` — three-way branching in `buildBuilderContinuationInput`; emit `agent:retry:aborted` in `withRetry` catch.
- `packages/engine/src/events.ts` — add `agent:retry:aborted` to the event union.
- `packages/monitor-ui/src/lib/reducer.ts` + `components/timeline/event-card.tsx` (or equivalent) — render the new event.
- `packages/eforge/src/cli/display.ts` — CLI rendering for parity.
- `packages/pi-eforge/…` — Pi parity per AGENTS.md's "keep plugin and pi in sync" rule.
- `test/retry.test.ts` — two new cases:
  - **Committed-progress retry**: stub builder makes a commit, then yields `build:failed` with `terminalSubtype: 'error_max_turns'`. Assert a `build:implement:continuation` event fires and a second attempt runs with a non-empty `completedDiff` in its input.
  - **No-progress hard fail**: stub builder commits nothing and yields the same terminal event. Assert no retry, the held-back `build:failed` surfaces, and the new `agent:retry:aborted` diagnostic fires.

### Out of scope

- Changes to the existing "No skipping verification" rule in the builder prompt.
- Schema changes to `BuilderContinuationInput` (`baseBranch` is already present at `retry.ts:294`).
- Modifying existing retry tests (uncommitted-changes retry, retry-then-success, exhaustion) beyond keeping them green.

## Acceptance Criteria

1. `pnpm test && pnpm build && pnpm type-check` pass at the repo root.
2. Unit coverage: `pnpm test -- retry` — the two new cases pass, and existing tests (uncommitted-changes retry, retry-then-success, exhaustion) stay green.
3. The **Committed-progress retry** test asserts that when a stub builder commits then yields `build:failed` with `terminalSubtype: 'error_max_turns'`, a `build:implement:continuation` event fires and a second attempt runs with a non-empty `completedDiff` in its input.
4. The **No-progress hard fail** test asserts that when a stub builder commits nothing and yields the same terminal event, no retry occurs, the held-back `build:failed` surfaces, and the new `agent:retry:aborted` diagnostic fires.
5. `agent:retry:aborted` is added to the `EforgeEvent` union in `packages/engine/src/events.ts` and is rendered in:
   - the monitor UI event renderer (`packages/monitor-ui/src/lib/reducer.ts` + `components/timeline/event-card.tsx` or equivalent),
   - the CLI (`packages/eforge/src/cli/display.ts`),
   - the Pi extension (`packages/pi-eforge/…`) per the plugin/Pi sync rule.
6. `buildBuilderContinuationInput` implements the three-way branch: uncommitted → checkpoint + diff; clean with new commits → skip checkpoint, build diff from `baseBranch...HEAD`; clean with no commits → throw descriptive error.
7. The bare `catch {}` at `retry.ts:656-662` is replaced with a handler that emits `agent:retry:aborted` (including `reason` from the thrown error) before yielding the held-back terminal event.
8. `packages/engine/src/prompts/builder.md`:
   - Section header "## Commit" is renamed to "## Commit (last step — stop after this)".
   - A "Stop after commit" constraint is added under Constraints (around line 58) with the exact guidance that no additional verification, reads, greps, status checks, or 'double-check' operations should run after `git commit` succeeds, that verification belongs before the commit, and that `git log` confirmation is the orchestrator's job.
   - A one-liner reinforcing the same point is added in the body of the "## Commit" section next to the `git commit` template.
   - The existing "No skipping verification" rule is preserved as-is.
9. End-to-end spot-check (manual, after landing): enqueue a PRD whose builder is likely to commit mid-stream and hit turns; confirm the monitor shows `build:implement:continuation` + `agent:retry`, and that a re-entered builder picks up verification cleanly. If hard to force naturally, set `max_continuations: 3` + a small `maxTurns` in the plan front-matter to reliably trigger the path.
10. Regression: rerunning the previously failed PRD (`eforge/queue/failed/per-command-timeout-for-post-merge-validate-phase.md`) shows continuation engaging rather than hard-failing.

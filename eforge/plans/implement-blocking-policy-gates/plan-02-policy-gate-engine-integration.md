---
id: plan-02-policy-gate-engine-integration
name: Policy Gate Queue and Merge Integration
branch: implement-blocking-policy-gates/plan-02-policy-gate-engine-integration
agents:
  builder:
    effort: high
    rationale: Wires blocking behavior into scheduler and orchestration paths and
      adds git diff helpers before mutating merges.
  reviewer:
    effort: high
    rationale: Blocking policy gates affect build outcomes, queue state, and merge
      safety; review must inspect failure paths and event ordering.
  tester:
    effort: high
    rationale: Integration tests must cover queue dispatch, plan merge, final merge,
      and git diff behavior across multiple code paths.
---

# Policy Gate Queue and Merge Integration

## Architecture Context

Plan 1 adds policy gate registration metadata, config, events, and a runtime executor. This plan consumes that foundation at the existing parent-process and merge decision points:

- `packages/engine/src/queue/scheduler.ts` before a queued PRD spawns a child build.
- `packages/engine/src/orchestrator/phases.ts` before `WorktreeManager.mergePlan()` and before `WorktreeManager.mergeToBase()`.
- `packages/engine/src/worktree-manager.ts` for pre-mutation file diff summaries.

The engine must keep communication event-based and reuse existing queue/orchestration failure paths.

## Implementation

### Overview

Pass the policy gate registry/config to the scheduler and orchestrator, compute candidate file diffs before merge mutations, execute gates at the three in-scope decision points, and convert blocking outcomes into existing failed/skipped lifecycle behavior.

### Key Decisions

1. Run `beforeQueueDispatch` after `daemon:scheduler:dequeued` and before profile routing, `session:start`, semaphore acquisition, or child spawn. This avoids router persistence and child side effects for PRDs blocked by policy.
2. Queue dispatch context uses the queued PRD's current frontmatter profile. Router-selected profiles are not available because dispatch policy runs before routers.
3. For queue dispatch blocks, move the PRD to `failed/` with `movePrdToSubdir()` best-effort, emit policy events, then emit `queue:prd:complete` with status `failed`. Existing scheduler completion logic handles dependent propagation.
4. Run `beforePlanMerge` after `plan:merge:start` and before `WorktreeManager.mergePlan()`. A block marks the plan failed, emits `plan:build:failed`, adds the plan to `failedMerges`, and calls existing dependent propagation.
5. Run `beforeFinalMerge` after optional cleanup and immediately before `WorktreeManager.mergeToBase()`, so the final diff represents the feature branch candidate that would be merged to base.
6. For direct-on-merge plans, the gate cannot undo commits already made on the feature branch. A block prevents marking the plan merged and prevents final merge to base, leaving the feature branch/merge worktree for inspection.
7. Diff summaries are path/status only and are computed before gated merge operations mutate their destination.

## Scope

### In Scope

- Pass policy gate registry/config through `EforgeEngine`, `QueueScheduler`, `OrchestratorOptions`, and `PhaseContext`.
- Execute `beforeQueueDispatch`, `beforePlanMerge`, and `beforeFinalMerge` with the runtime from Plan 1.
- Add worktree diff helpers for plan merge and final merge candidates.
- Record per-plan base SHA during `WorktreeManager.acquireForPlan()` for both dedicated worktree and direct-on-merge plan modes.
- Map git name-status output to SDK `ExtensionDiff.files` statuses: `added`, `modified`, `deleted`, and `renamed`.
- Convert policy blocks and require-approval decisions into existing failed/skipped build behavior.
- Integration tests for queue dispatch blocking, plan merge blocking, final merge blocking, dependent propagation, no-spawn/no-merge assertions, and diff summaries.

### Out of Scope

- Enqueue-time policy gates.
- Validation-provider or before-validation gates.
- Approval workflow state, UI, or pause/resume semantics for `require-approval`.
- Sandboxing extension code.
- Custom monitor UI cards beyond registry summaries unless a compile or test failure proves generic rendering is insufficient.

## Files

### Create

None expected.

### Modify

- `packages/engine/src/worktree-manager.ts` — add `baseSha` to managed plan worktrees, capture it at acquire time, add `getPlanDiff(planId, plan)` and `getFinalMergeDiff(baseBranch)` or equivalent helpers, and parse git name-status output into `ExtensionDiff`.
- `packages/engine/src/worktree-ops.ts` — add shared git diff/name-status parsing helpers here only if keeping them out of `WorktreeManager` reduces duplication.
- `packages/engine/src/orchestrator.ts` — add optional policy registry/config fields to `OrchestratorOptions` and pass them into `PhaseContext`.
- `packages/engine/src/orchestrator/phases.ts` — execute plan and final merge gates, yield policy events, and route block results through existing plan failure, dependent propagation, and finalize skipped behavior.
- `packages/engine/src/queue/scheduler.ts` — accept policy gates in `extensionRegistry`, build queue dispatch context, execute policy gates before profile routing/session start/spawn, move blocked PRDs to `failed/` best-effort, and emit `queue:prd:complete` with status `failed`.
- `packages/engine/src/eforge.ts` — pass the full/in-scope extension registry and policy config into `QueueScheduler` and `Orchestrator`.
- `test/queue-scheduler.test.ts` — add dispatch policy tests using a real `QueueScheduler`, in-memory event queue, and real queue files.
- `test/orchestration-logic.test.ts` — add blocked plan merge and blocked final merge tests with stub `WorktreeManager` methods that fail the test if called after a block.
- `test/worktree-integration.test.ts` — add git-backed diff summary coverage for added, modified, deleted, and renamed files.
- `test/worktree-manager.test.ts` — add focused coverage for direct-on-merge base SHA capture and plan diff computation if this file is the better home for manager-level tests.

## Verification

- [ ] `pnpm type-check` exits 0 after scheduler/orchestrator option and context changes.
- [ ] `pnpm test -- test/queue-scheduler.test.ts test/orchestration-logic.test.ts test/worktree-integration.test.ts test/worktree-manager.test.ts test/extension-policy-gate-runtime.test.ts` exits 0.
- [ ] A queue dispatch block test observes zero `spawnPrdChild` calls, zero `session:start` events, emitted policy events, and a `queue:prd:complete` event with status `failed`.
- [ ] A queue dispatch block with a dependent PRD leaves the dependent unspawned after scheduler completion propagation.
- [ ] A plan merge block test observes zero `mergePlan` calls, a failed plan state, a `plan:build:failed` event with policy reason text, and blocked dependent plans.
- [ ] A final merge block test observes zero `mergeToBase` calls, one `merge:finalize:skipped` event with policy reason text, and final state status `failed`.
- [ ] Diff summary tests assert path/status entries for added, modified, deleted, and renamed files before merge mutation.
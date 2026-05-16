---
title: Implement blocking policy gates
created: 2026-05-16
profile: pi-codex-5-5
---

# Implement blocking policy gates

## Problem / Motivation

eforge can load and report policy-gate registrations such as `beforePlanMerge`, but those gates do not execute at runtime. Users can write a `protected-paths` extension that appears in provenance, yet it cannot actually block unsafe merges.

This affects teams using eforge TypeScript extensions to enforce project policy around sensitive files, generated artifacts, deployment config, database migrations, production settings, or other risky changes.

This matters now because event hooks, agent-context/tool hooks, and profile routers are already runtime-supported. Policy gates are the next extension phase and are explicitly meant to be the first blocking extension capability. Without this, extension authors may believe policy code is active when docs still say it is deferred.

Blocking hooks must be stricter than event hooks. They need typed decisions, deterministic timeout/failure semantics, provenance-rich events, and clear integration with queue/orchestrator state so a blocked operation fails/skips safely without hidden mutation.

### Evidence sources reviewed

- Schaake OS epic `0c2e2570-87c8-4a12-a2e3-178e27564a9d` asks for controlled blocking lifecycle hooks that can allow, block, or require approval for sensitive operations. Acceptance criteria allow an initial gate subset if documented, require typed decisions, configurable timeout/failure policy, decision events with provenance/reason, and no hidden mutation contracts.
- `docs/prd/typescript-extensibility.md` defines Phase 3 policy gates: before enqueue, queue dispatch, plan merge, final merge, and validation; explicit allow/block/modify contracts; timeout/failure policy; decision events; no hidden mutation. It also lists project policy gates as a high-value use case.
- `docs/roadmap.md` keeps Native TypeScript extensions as the active extensibility roadmap direction.
- `docs/extensions.md` and `docs/extensions-api.md` show the current public API only includes `beforePlanMerge(handler)` for policy gates. Loader-time registration capture exists, but runtime execution is explicitly deferred. The `PolicyDecision` union is already `allow | block | require-approval`; `modify` is intentionally absent.
- `examples/extensions/protected-paths.ts` demonstrates `beforePlanMerge` and currently warns that runtime enforcement is deferred.
- `packages/engine/src/extensions/types.ts` and `recorder.ts` already capture `policyGates` as handlers, but there is no policy-gate runtime module.
- `packages/engine/src/extensions/profile-router-runtime.ts` provides a close pattern for sequential extension handler execution with timeout, diagnostics, provenance, and fail-open behavior in the queue scheduler.
- `packages/engine/src/extensions/event-runtime.ts` and `agent-context-runtime.ts` provide context/logger/exec and diagnostic event patterns for extension runtime code.
- `packages/engine/src/config.ts` has extension timeout config for event hooks, agent context hooks, and profile routers. It lacks `policyGateTimeoutMs` and a policy failure mode.
- `packages/engine/src/orchestrator/phases.ts` is the plan/final merge orchestration point: `executePlans()` emits `plan:merge:start`, calls `ctx.worktreeManager.mergePlan()`, and transitions plans; `finalize()` emits `merge:finalize:start` and calls `ctx.worktreeManager.mergeToBase()`.
- `packages/engine/src/worktree-manager.ts` owns plan merge and final merge operations. It does not currently expose diff summaries for policy gates and does not record per-plan base SHAs.
- `packages/engine/src/queue/scheduler.ts` is the parent-process dispatch point. It already receives an extension registry, but only with `profileRouters`; it emits `daemon:scheduler:dequeued` before routing/session start and can mark PRDs skipped/failed before child spawn.
- `packages/monitor/src/server.ts` handles API enqueue by spawning an enqueue worker; this is a separate path from queue dispatch and would require daemon-parent gate execution if included.
- `packages/client/src/events.schemas.ts` and `event-registry.ts` are the wire-protocol/event registry sources of truth for adding policy decision/failure/timeout events.

### Classification

**Feature / focused**, high confidence.

This is a runtime implementation of an existing SDK registration family across engine queue/orchestration and client event schemas. It is cross-cutting but cohesive enough for one planner; no new broad workflow automation should be introduced.

### Profile signal

Recommended eforge profile: **Excursion**.

Rationale: this is cross-cutting engine/client/docs work, but it is cohesive: one runtime capability family with clear integration points: queue scheduler, orchestrator merge phases, extension registry, and event schemas. A single planner can enumerate the changes and tests. It is too risky for Errand because it affects blocking behavior and build outcomes. It does not require Expedition because it does not need delegated subsystem planning or a new broad architecture; enqueue and validation gates are explicitly deferred to keep the slice bounded.

## Goal

Implement a documented MVP subset of policy gates so extensions can block sensitive operations at runtime.

The MVP should runtime-execute `beforeQueueDispatch`, `beforePlanMerge`, and `beforeFinalMerge` with typed contexts, typed decisions, timeout/failure policy, provenance-rich events, and safe integration into queue/orchestrator behavior.

## Approach

Implement these gates as a cohesive runtime capability family across the extension SDK, engine runtime, queue scheduler, orchestrator merge phases, worktree diff helpers, client event schemas, docs, examples, and tests.

### Primary code changes

- `packages/extension-sdk/src/api.ts`, `context.ts`, `hooks.ts`, `index.ts`, README:
  - Add `beforeQueueDispatch`.
  - Add `beforeFinalMerge`.
  - Add gate-specific context types.
  - Document runtime status.
  - Keep `beforePlanMerge` compatible.

- `packages/engine/src/extensions/types.ts` and `recorder.ts`:
  - Represent policy-gate registrations with a gate kind:
    - `queue-dispatch`
    - `plan-merge`
    - `final-merge`
  - Include stable registration metadata:
    - extension name/path
    - method/kind
    - likely registration index
  - Capture new registration methods.
  - Validate handlers.

- New `packages/engine/src/extensions/policy-gate-runtime.ts`:
  - Execute policy gates sequentially.
  - Build read-only contexts.
  - Validate `PolicyDecision`.
  - Apply timeout and failure policy.
  - Emit `extension:policy:*` events.
  - Return an aggregate allow/block result to callers.

- `packages/engine/src/extensions/index.ts`:
  - Export the policy runtime and updated types.

- `packages/engine/src/config.ts`:
  - Add `extensions.policyGateTimeoutMs`.
  - Add `extensions.policyGateFailurePolicy`.
  - Include defaults and merge behavior.
  - Update generated config docs/reference through docs generation if config reference is generated from schema.

- `packages/client/src/events.schemas.ts`, `event-registry.ts`, client tests/wire parity:
  - Add `extension:policy:decision`, `extension:policy:failed`, and `extension:policy:timeout`, or equivalent names.
  - Use scope/persistence consistent with other extension diagnostics.

- `packages/engine/src/queue/scheduler.ts`:
  - Pass `policyGates` in the extension registry.
  - Run `beforeQueueDispatch` before session start/child spawn.
  - Emit diagnostic/decision events.
  - Complete the PRD as `failed` when blocked so dependent PRDs are skipped via existing `propagateSkip`/`propagateBlocked` behavior.

- `packages/engine/src/eforge.ts`:
  - Pass the full/in-scope extension registry to `QueueScheduler`.
  - Pass registry/config into orchestrator phase context if not already available.

- `packages/engine/src/orchestrator.ts` and/or `packages/engine/src/orchestrator/phases.ts`:
  - Add policy gate registry/config to `PhaseContext`.
  - Run `beforePlanMerge` before `worktreeManager.mergePlan()`.
  - Run `beforeFinalMerge` before `worktreeManager.mergeToBase()`.

- `packages/engine/src/worktree-manager.ts` and possibly `worktree-ops.ts`:
  - Add helpers to compute file-level diffs for plan and final merge contexts before mutation.
  - Likely record each plan’s base SHA at `acquireForPlan()` so directly-on-merge plans can be diffed after build but before marking merged.

- Docs/examples:
  - Update `docs/extensions.md`.
  - Update `docs/extensions-api.md`.
  - Update `packages/extension-sdk/README.md`.
  - Update `examples/extensions/README.md`.
  - Update `examples/extensions/protected-paths.ts`.
  - Update generated web/public mirrors if docs generation updates them.

- Monitor/CLI display:
  - Add basic rendering/summary for new policy events in `packages/eforge/src/cli/display.ts` and `packages/monitor-ui/src/components/timeline/event-card.tsx` only if generic event rendering is insufficient or tests require explicit display.

### Design decisions

1. **MVP gate subset: queue dispatch + plan merge + final merge.**
   - Decision: implement these three gates and explicitly defer enqueue/validation gates.
   - Rationale: plan/final merge are the most direct project-policy use cases, and queue dispatch is already a parent-process decision point similar to profile routing. Enqueue spans daemon route, CLI, source normalization, and worker subprocess boundaries, so it is a larger follow-up.

2. **Use explicit gate kinds instead of one undifferentiated `policyGates` array.**
   - Decision: model registrations as `{ gateKind, extensionName, extensionPath, handler, registrationIndex }` or equivalent.
   - Rationale: events and runtime dispatch need to distinguish queue dispatch, plan merge, and final merge provenance. Existing loader capture can migrate without breaking the public `beforePlanMerge` API.

3. **Run gates sequentially and short-circuit on first blocking result.**
   - Decision: preserve registration order. Emit `allow` decisions, but continue; emit `block`/`require-approval` and stop further gates for that operation.
   - Rationale: simple deterministic behavior, matches profile-router first-valid-wins style, and avoids conflicting policy outcomes.

4. **Treat `require-approval` as blocking in this MVP.**
   - Decision: no approval queue/state/UI is added. `require-approval` produces a policy decision event and blocks with a reason that approval runtime is not yet implemented.
   - Rationale: the existing SDK already exposes the union variant, but approval workflows are broader than this epic and belong in a later task.

5. **Configurable failure semantics with safety-first default.**
   - Decision: add `extensions.policyGateFailurePolicy: 'fail-closed' | 'fail-open'`; recommend/default `fail-closed` for actual blocking gates unless implementation discovers a strong project convention for fail-open. Add `extensions.policyGateTimeoutMs`, defaulting to `eventHookTimeoutMs`.
   - Rationale: policy gates protect sensitive operations; silent bypass on handler failure is dangerous. The config escape hatch lets experimental/local gates avoid bricking builds.

6. **Validate decisions at runtime; reject mutation-shaped results.**
   - Decision: accept only `{ decision: 'allow' }`, `{ decision: 'block', reason }`, or `{ decision: 'require-approval', reason }`. Ignore/reject extra mutation contracts and document that no `modify` variant exists.
   - Rationale: acceptance criteria prohibit hidden state mutation outside documented contracts.

7. **Compute file diffs before mutating merge targets.**
   - Decision: add helper(s) to produce `ExtensionDiff` from git name-status output before plan/final merge. Record a plan base SHA at worktree acquisition so directly-on-merge plans can be diffed accurately.
   - Rationale: policy decisions need the candidate change set, not a post-merge result. Direct merge-worktree builds currently lack a stored pre-plan SHA.

8. **Wire policy blocks into existing failure paths.**
   - Decision: plan-merge block should reuse existing plan failure + dependent propagation. final-merge block should reuse `merge:finalize:skipped` + failed build status. queue-dispatch block should complete the PRD as `failed`, not `skipped`, so dependents do not incorrectly proceed.
   - Rationale: minimizes new scheduler/orchestrator semantics and keeps monitor/queue behavior predictable.

9. **Events are the source of observability.**
   - Decision: add typed events for policy decision/failure/timeout and route all user-visible gate outcomes through them. Include operation target fields, extension provenance, decision, reason, failure policy, and timeout.
   - Rationale: eforge architecture requires engine emits and consumers render; no stdout-only policy outcomes.

10. **Docs must remove stale deferred language only for shipped gates.**
    - Decision: docs should say queue dispatch, plan merge, and final merge are runtime-supported; before enqueue, before validation, approval UI, and mutation contracts remain deferred.
    - Rationale: avoids repeating the EXTEND_06 problem of overpromising unsupported extension APIs.

### Assumptions and validation

| Assumption | Evidence / validation performed | Confidence | Cost to validate further | Validation path | Impact if wrong |
|------------|----------------------------------|------------|--------------------------|-----------------|-----------------|
| A documented MVP subset is acceptable for EXTEND_10. | Epic acceptance explicitly says initial gates may include before enqueue/dispatch/merge “or a documented MVP subset.” PRD says task boundaries should stay small. | High | Low | Keep docs and acceptance criteria explicit about deferred gates. | If wrong, scope expands significantly to enqueue/validation gate work. |
| Queue dispatch is a practical parent-process gate. | `QueueScheduler.startReadyPrds()` already gates launch, emits `daemon:scheduler:dequeued`, runs profile routers before `session:start`, and can complete a PRD without spawning a child. | High | Low | Implement targeted scheduler unit test with a blocking gate and assert spawn is not called. | If wrong, dispatch gate may need to move earlier/later in the watcher pump. |
| Plan/final merge gates can be integrated in `orchestrator/phases.ts` before existing merge calls. | Code inspection shows `executePlans()` calls `worktreeManager.mergePlan()` after `plan:merge:start`; `finalize()` calls `worktreeManager.mergeToBase()` after `merge:finalize:start`. | High | Low | Add tests around blocked merge paths and existing transition events. | If wrong, WorktreeManager may need to own runtime invocation instead of phases. |
| Accurate plan diffs require recording a per-plan base SHA. | `WorktreeManager.acquireForPlan()` tracks plan worktrees but does not store a base SHA. Directly-on-merge plans build on the merge worktree, so branch-vs-feature diff alone cannot isolate the plan after work is already committed. | Medium | Medium | Prototype `git rev-parse HEAD` capture at acquisition and diff `baseSha..HEAD`/`baseSha..branch`; verify in worktree tests for dedicated and merge-worktree plans. | If wrong, policy gates may see incomplete or overbroad file lists and block/allow incorrectly. |
| Default `fail-closed` is appropriate for policy gates. | PRD asks the default failure policy question; no existing convention decides it. Safety rationale supports fail-closed, but event/profile hooks currently fail-open. | Medium | Low | User/product review during implementation; tests should support both fail-open and fail-closed regardless of default. | If default choice is wrong, builds may either become too fragile, fail-closed, or policies may silently bypass, fail-open. |
| `require-approval` should block until an approval workflow exists. | Existing `docs/extensions-api.md` says require-approval is reserved/future and in current policy runtime should be treated equivalent to block. | High | Low | Preserve/update docs and tests to assert block semantics. | If wrong, builds could pause indefinitely without an operator workflow. |
| Policy gates cannot fully prevent side effects from arbitrary TypeScript. | Extension docs explicitly state extensions are unsandboxed. Even read-only contexts cannot stop code from importing `fs` directly. | High | Low | Document this clearly; validate only that eforge accepts no mutation return contract. | If unstated, acceptance could be misread as a sandbox guarantee that eforge does not provide. |
| New policy event variants should be non-persistent session-scoped events, like other extension diagnostics. | Existing extension diagnostics and profile-router events in `event-registry.ts` use session scope and `persist: false`. | Medium | Low | Check monitor behavior and adjust if policy audit trails require persistence. | If wrong, policy decisions may not be retained where users expect auditability. |

No unresolved low-confidence/high-impact assumptions remain. The main medium-confidence decisions, `fail-closed` default and diff strategy, have clear validation paths and tests.

## Scope

### In scope

Implement a documented MVP subset of policy gates rather than every PRD-listed hook at once:

- Runtime execution for existing `beforePlanMerge(handler)` registrations.
- Add and runtime-execute `beforeFinalMerge(handler)` so teams can gate the final feature-branch merge to the base branch.
- Add and runtime-execute `beforeQueueDispatch(handler)` so teams can block queued PRDs before child build dispatch.
- Add typed gate contexts for the three in-scope gates:
  - Queue dispatch: queued PRD id/title/frontmatter/content/dependencies/priority/profile.
  - Plan merge: plan id/name plus file-level diff for that plan.
  - Final merge: feature/base branch plus aggregate file-level diff.
- Add policy-gate runtime support with sequential gate execution, timeout handling, failure policy, decision validation, provenance, and events.
- Add extension config fields for `policyGateTimeoutMs` and `policyGateFailurePolicy`.
- Add canonical event schemas/registry entries for policy decisions, handler failures, and timeouts.
- Wire gate decisions into queue/orchestrator behavior so `block` and `require-approval` stop the gated operation.
- Treat `require-approval` as a block in this MVP, with docs noting an approval workflow is future work.
- Update docs/API reference/examples to state that policy gates are runtime-supported for the MVP subset and identify deferred gates.
- Update tests for SDK types, loader capture, policy runtime, queue dispatch blocking, plan/final merge blocking, event schemas, and docs drift.

### Out of scope / deferred

- `beforeEnqueue` runtime. Enqueue happens through daemon route + worker and CLI paths; gating it cleanly requires a parent/worker contract and normalized source context. Document it as deferred.
- `beforeValidation` runtime and custom validation-provider execution.
- Any approval UI/state machine. `require-approval` emits a decision and blocks for now.
- A `modify` decision or any in-place mutation contract.
- Sandboxing arbitrary extension code. Existing trust model remains; gates get read-only typed contexts and no mutation result is accepted, but arbitrary trusted TypeScript can still side-effect.

## Acceptance Criteria

- SDK exports include typed APIs and contexts for `beforeQueueDispatch`, `beforePlanMerge`, and `beforeFinalMerge`; existing `beforePlanMerge` remains backward-compatible.
- Loader/recorder captures all in-scope policy gate registrations with provenance and validation diagnostics.
- Policy-gate runtime executes registered gates sequentially with configurable timeout, `extensions.policyGateTimeoutMs`, defaulting to event hook timeout, and configurable failure policy, `extensions.policyGateFailurePolicy`, with a documented default.
- Gate return values are validated as `allow`, `block`, or `require-approval`; unsupported/invalid returns follow the configured failure policy and emit diagnostics.
- Every gate decision emits a typed event with gate kind, operation target, extension name/path, decision, optional reason, timeout/failure policy provenance, and relevant target identifiers.
- Gate failures and timeouts emit typed events. When configured fail-closed, they also produce a blocking decision; when fail-open, the next gate/operation proceeds.
- `beforeQueueDispatch` block/require-approval prevents child build spawn and marks the PRD complete with a skipped/failed blocked status consistently with scheduler behavior.
- `beforePlanMerge` block/require-approval prevents that plan merge, marks the plan failed with a policy reason, emits `plan:build:failed`, and propagates failures to dependents using existing orchestration logic.
- `beforeFinalMerge` block/require-approval emits `merge:finalize:skipped`, marks the build failed, and leaves the feature branch/merge worktree for inspection.
- File diffs passed to policy contexts are path/status summaries only and are computed before the gated merge operation mutates the destination.
- Docs, including `docs/extensions.md`, `docs/extensions-api.md`, SDK README, examples README, and config docs/reference if applicable, describe supported policy-gate runtime behavior, config, failure semantics, and deferred gates: `beforeEnqueue`, `beforeValidation`, and approval workflow.
- `examples/extensions/protected-paths.ts` no longer says enforcement is deferred for `beforePlanMerge`; add/update examples for final merge and/or queue dispatch if appropriate.
- Tests run successfully for policy runtime, event schemas/registry, scheduler integration, orchestrator merge integration, extension loader/SDK examples, and docs checks.

### Tests to add/update

- SDK/example tests:
  - Type exports.
  - `protected-paths` compiles against updated runtime-supported docs.
- Loader tests:
  - Capture each policy gate kind.
  - Invalid handler diagnostics.
  - Multiple gates from one extension preserve provenance.
- New policy runtime unit tests:
  - `allow`
  - `block`
  - `require-approval`
  - invalid returns
  - thrown errors
  - timeouts
  - fail-open vs fail-closed
- Queue scheduler tests:
  - Blocking dispatch prevents spawn.
  - Emits policy events.
  - Marks PRD failed so dependents are blocked.
- Orchestrator/worktree tests:
  - Blocking plan merge prevents merge and propagates failure.
  - Blocking final merge skips finalize and marks build failed.
  - Diff summaries include expected file statuses.
- Client event schema/registry tests and docs/reference drift checks.

### Validation commands

```bash
pnpm test -- test/extension-loader.test.ts test/extension-sdk-example.test.ts test/extension-policy-gate-runtime.test.ts test/queue-scheduler.test.ts test/orchestration-logic.test.ts test/worktree-integration.test.ts packages/client/src/__tests__/events-schemas.test.ts
pnpm type-check
pnpm docs:generate && pnpm docs:check
```

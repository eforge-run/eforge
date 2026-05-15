---
title: Generalize transient transport retry handling across eforge agents
created: 2026-05-15
depends_on: ["harden-review-evaluation-cycles"]
profile: pi-codex-5-5
---

# Generalize transient transport retry handling across eforge agents

## Problem / Motivation

This is a **bugfix / focused** change (confidence: high). A real build failed from a transient backend WebSocket error during a late evaluator pass even though eforge already has transport-resilience machinery.

A build can still fail terminally on a transient backend WebSocket error even though eforge has an `error_transient_transport` classifier and a shared retry wrapper.

### Context and evidence

- `docs/roadmap.md` does not list this exact bug, but the work aligns with Integration & Maturity by improving build lifecycle resilience. It is not a new wrapper-app workflow; the failure occurs inside engine agent orchestration.
- `AGENTS.md` confirms engine behavior should flow through typed `EforgeEvent`s and engine state mutation/decision helpers; no daemon/client route changes are implied.
- `packages/engine/src/harness.ts` defines `error_transient_transport` and classifies observed messages such as `Backend error: WebSocket error` and `WebSocket closed 1012`.
- `packages/engine/src/retry.ts` already contains a unified `withRetry()` wrapper plus role-specific `RetryPolicy` entries. This supports a DRY fix through policy/helper changes rather than ad hoc retry loops.
- Current policy coverage is uneven:
  - `builder` and sharded builder retry `error_transient_transport`;
  - planner can retry it only before submission;
  - `evaluator`, `plan-evaluator`, `cohesion-evaluator`, and `architecture-evaluator` currently retry only `error_max_turns`.
- `packages/engine/src/agents/builder.ts` has builder-specific post-result downgrade logic: if a transient transport error occurs after `agent:result` and `HEAD` advanced, builder emits a warning and completes successfully. Evaluator has no analogous special-case; it emits `plan:build:failed` with a terminal subtype and relies on policy.
- `packages/engine/src/pipeline/stages/build-stages.ts` wraps build evaluator with `withRetry(DEFAULT_RETRY_POLICIES.evaluator)`, so adding `error_transient_transport` to evaluator policy would affect the observed failure path.
- `packages/engine/src/pipeline/runners.ts` wraps compile-phase evaluators through `DEFAULT_RETRY_POLICIES[config.evaluator.role]`, so plan/cohesion/architecture evaluators can share the same retry posture.
- Existing tests already cover classifier behavior and builder/planner transient handling in `test/pi-transport-resilience.test.ts`, plus generic retry semantics and evaluator max-turn continuation in `test/retry.test.ts`.
- Runtime evidence from `.eforge/monitor.db`: 68 events contain `Backend error: WebSocket error`, including the failed EXTEND_07 evaluator path:
  - `agent:result` for evaluator;
  - then `agent:stop` with WebSocket error;
  - then `plan:build:failed` with `terminalSubtype: error_transient_transport`.
  - No `agent:retry` event was recorded for that run.

### Observed symptom from EXTEND_07

- The build reached a late evaluator pass after implementation, docs, tests, review, review-fix, and prior evaluator cycles had completed.
- The evaluator emitted `agent:result`, then the Pi backend stream ended with `Backend error: WebSocket error`.
- The engine emitted `plan:build:failed` with `terminalSubtype: error_transient_transport`.
- No `agent:retry` event was recorded because `DEFAULT_RETRY_POLICIES.evaluator` does not currently include `error_transient_transport`.

Affected users are anyone running long eforge builds through Pi/agent backends where transient transport failures can occur after expensive work has already completed. The immediate impact is unnecessary failed PRDs and manual salvage work even when the underlying code changes are complete or retryable.

This should be fixed inside the engine retry policy/continuation architecture, not by adding daemon-level queue retries or ad hoc catch blocks.

### Reproduction steps

Concrete observed reproduction from monitor history:

1. Run a build that reaches a build evaluator stage using the Pi backend.
2. Let the evaluator complete far enough to emit `agent:result`.
3. The backend stream then reports `Backend error: WebSocket error` before clean completion.
4. Actual behavior:
   - `agent:stop` includes the WebSocket error.
   - `plan:build:failed` is emitted with `terminalSubtype: error_transient_transport`.
   - No `agent:retry` event is emitted.
   - The PRD is marked failed and recovery classifies it as retry/manual-salvage even if commits landed.
5. Expected behavior:
   - The retry wrapper should recognize the evaluator terminal subtype as retryable.
   - If the evaluator has already processed all unstaged changes, the existing evaluator continuation builder should return `abort-success` and drop the held-back failure.
   - If unstaged changes remain, the evaluator should retry once with continuation context.

Evidence command used during planning:

- `sqlite3 .eforge/monitor.db ... data like '%Backend error: WebSocket error%'` found the EXTEND_07 sequence: evaluator `agent:result` at `2026-05-15T17:32:35.355Z`, evaluator `agent:stop` with WebSocket error, then `plan:build:failed` with `terminalSubtype: error_transient_transport`.

## Goal

Generalize transient transport retry handling for evaluator-family agents by routing `error_transient_transport` through the existing `withRetry()` and evaluator continuation flow.

The fix should preserve planner safeguards, avoid blanket retries for roles without continuation/checkpoint semantics, and prevent unnecessary terminal build failures from retryable evaluator WebSocket errors.

## Approach

### Root cause

Root cause confirmed by code inspection:

- Transient transport classification exists in `packages/engine/src/harness.ts`:
  - `isTransientTransportError()` recognizes `Backend error: WebSocket error`.
  - `classifyAgentTerminalSubtype()` maps it to `error_transient_transport`.
- The shared retry engine exists in `packages/engine/src/retry.ts`:
  - `withRetry()` can retry thrown classified errors or held-back `plan:build:failed` events with `terminalSubtype`.
  - Retry behavior is controlled by role-specific `RetryPolicy.retryableSubtypes` plus optional `shouldRetry` and `buildContinuationInput`.
- The evaluator path is already wrapped in `withRetry()`:
  - Build evaluator: `packages/engine/src/pipeline/stages/build-stages.ts` uses `DEFAULT_RETRY_POLICIES.evaluator`.
  - Compile evaluators: `packages/engine/src/pipeline/runners.ts` uses `DEFAULT_RETRY_POLICIES[config.evaluator.role]`.
- The policy gap is explicit:
  - `builder` uses `RETRYABLE_MAX_TURNS_OR_TRANSIENT_TRANSPORT`.
  - sharded builder policy includes `error_transient_transport`.
  - planner allows transient retry only pre-submission via `shouldRetry`.
  - `evaluator`, `plan-evaluator`, `cohesion-evaluator`, and `architecture-evaluator` use only `RETRYABLE_MAX_TURNS`.

Therefore, when `builderEvaluate()` catches a transient WebSocket error, it emits `plan:build:failed` with `terminalSubtype: error_transient_transport`; `withRetry()` holds it back, checks policy, and then propagates it because evaluator policy does not mark that subtype retryable.

### Implementation approach

1. Add a DRY helper/constant for evaluator-style retryable subtypes, e.g. `RETRYABLE_MAX_TURNS_OR_TRANSIENT_TRANSPORT`, and use it for all evaluator-family policies where the existing `buildEvaluatorContinuationInput()` applies.
2. Keep planner's special `shouldRetry` guard intact; do not make transient retry unconditional after `planning:submission`.
3. Do not give all unregistered roles a blanket transient retry by default. `getPolicy()` should continue to return a no-retry default because roles without continuation/checkpoint semantics may duplicate side effects.
4. Add tests proving evaluator-family transient retry and abort-success behavior. Prefer extending existing retry/transport tests rather than adding a parallel mechanism.

### Test reproduction to add

In `test/pi-transport-resilience.test.ts` or `test/retry.test.ts`, script `builderEvaluate()` or a retry-wrapped evaluator attempt to yield/emit a transient transport terminal event and verify:

- retry path when `checkHasUnstagedChanges` returns true;
- abort-success path when `checkHasUnstagedChanges` returns false;
- no retry for non-transient backend errors.

### Assumptions and validation

| Assumption | Evidence / validation performed | Confidence | Cost to validate further | Validation path | Impact if wrong |
|------------|----------------------------------|------------|--------------------------|-----------------|-----------------|
| Evaluator transient transport retries are safe when routed through existing evaluator continuation logic. | Read `buildEvaluatorContinuationInput()` in `packages/engine/src/retry.ts`: clean worktree returns `abort-success`; otherwise continuation context is injected. Existing tests cover evaluator max-turn retry and clean-worktree abort-success. | high | low | Add transient-specific evaluator tests with `checkHasUnstagedChanges` true/false. | Medium/high: unsafe retry could duplicate evaluator mutations or mask incomplete evaluation. |
| The observed EXTEND_07 failure was missed specifically because evaluator policy excludes `error_transient_transport`. | Read `DEFAULT_RETRY_POLICIES.evaluator` and monitor DB event sequence. `withRetry()` supports terminal subtype retry, but policy only includes `error_max_turns`. | high | low | Add regression test that fails on current policy and passes after adding transient subtype. | High: if wrong, the bug would persist despite policy changes. |
| Compile evaluator roles can share the same transient retry policy as build evaluator. | Read `pipeline/runners.ts`: compile review cycle uses `EvaluatorContinuationInput` and `DEFAULT_RETRY_POLICIES[config.evaluator.role]`. Policies already share `buildEvaluatorContinuationInput`. | medium-high | low | Add policy assertions and/or a `withRetry` test for one compile evaluator role. | Medium: compile review cycles could remain vulnerable or retry unsafely. |
| Blanket transient retry for all agent roles is unsafe today. | `retry.ts` intentionally uses explicit policies and `getPolicy()` no-retry default. Several roles are mutating or lack continuation/checkpoint input. | high | medium | Audit each unregistered role individually in a later PRD. | High: global retries could duplicate side effects or corrupt working trees. |
| This bugfix does not require client/daemon API or docs updates. | Change is engine-internal retry policy/testing; no wire shape changes needed because `agent:retry` and `error_transient_transport` already exist in client schemas. | high | low | Run type-check/tests; grep event schema if modifying events (not expected). | Low: docs might omit behavior, but functionality is internal resilience. |

No low-confidence/high-impact assumptions remain for this focused bugfix. Broader retry coverage for additional roles should be planned separately after auditing side effects and continuation semantics.

## Scope

### In scope

- Engine-internal retry policy/helper changes for evaluator-family agents.
- `error_transient_transport` handling through the existing centralized classifier and `withRetry()` path.
- Evaluator-family policies:
  - `evaluator`
  - `plan-evaluator`
  - `cohesion-evaluator`
  - `architecture-evaluator`
- Tests covering:
  - evaluator transient retry;
  - evaluator abort-success behavior;
  - no retry for non-transient backend errors;
  - compile evaluator-family policy behavior;
  - preservation of builder/planner transport-resilience behavior.
- Validation with `pnpm type-check` and relevant Vitest suites.

### Out of scope

- Daemon-level queue retries.
- Ad hoc catch blocks or retry loops.
- Client/daemon route or API changes.
- Duplicate WebSocket string matching in agents or stages.
- Blanket transient retry for all `AgentRole`s.
- Changing planner safeguards so post-submission transient failures are blindly rerun.
- Broad retry coverage for additional roles such as reviewer, doc-author, doc-syncer, tester, and review-fixer. These may also encounter WebSocket errors, and some are read-only/idempotent enough to consider later, but many can mutate files or leave partial changes. This PRD should focus on evaluator-family agents because they already have a continuation/abort-success contract and were the observed failure mode.
- Fully generalizing the builder-specific post-result downgrade. The existing builder-specific post-result downgrade is not fully generalized; a future architecture hardening could introduce a reusable post-result/side-effect checkpoint helper, but that is broader than this bugfix.

### Profile signal

Recommended profile: **Excursion**.

Rationale: this is a focused bugfix, but it touches central engine retry policy and needs careful tests around idempotency/continuation semantics. A single cohesive plan can cover the change without delegated module planning, so Expedition would be too heavy. Errand is too light because the safety boundary is subtle: blanket retry is explicitly out of scope and evaluator-family retry must be validated with regression tests.

## Acceptance Criteria

- `error_transient_transport` remains classified centrally by `packages/engine/src/harness.ts`; no duplicate WebSocket string matching is added in agents or stages.
- Evaluator-family retry policies (`evaluator`, `plan-evaluator`, `cohesion-evaluator`, `architecture-evaluator`) treat `error_transient_transport` as retryable through the existing `withRetry()` path.
- Existing planner safeguards remain intact: transient transport is retried only before `planning:submission` / `planning:skip`; post-submission transient failures are not blindly rerun.
- `getPolicy()` continues to return a no-retry default for roles without explicit policy; no blanket retry is introduced for all agents.
- Build evaluator behavior is covered by tests:
  - transient WebSocket failure with remaining unstaged changes emits `agent:retry` and retries with evaluator continuation context;
  - transient WebSocket failure with no remaining unstaged changes aborts success and drops the held-back `plan:build:failed`;
  - non-transient backend errors still do not retry.
- Compile evaluator-family policy behavior is covered by tests or policy assertions for `plan-evaluator`, `cohesion-evaluator`, and `architecture-evaluator`.
- Existing transport-resilience tests for builder/planner still pass, including planner no-retry after submission.
- Full validation passes:
  - `pnpm type-check`
  - relevant Vitest suites:
    - `test/retry.test.ts`
    - `test/pi-transport-resilience.test.ts`
    - any touched wiring tests.

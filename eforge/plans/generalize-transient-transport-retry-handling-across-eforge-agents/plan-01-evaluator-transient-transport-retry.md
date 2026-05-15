---
id: plan-01-evaluator-transient-transport-retry
name: Evaluator Transient Transport Retry Policy
branch: generalize-transient-transport-retry-handling-across-eforge-agents/plan-01-evaluator-transient-transport-retry
---

# Evaluator Transient Transport Retry Policy

## Architecture Context

Eforge already has centralized transient transport classification in `packages/engine/src/harness.ts` and a shared retry wrapper in `packages/engine/src/retry.ts`. The remaining gap is policy coverage: evaluator-family agents use the same continuation/abort-success flow as max-turn retries, but their default policies only list `error_max_turns`. This plan keeps retry behavior centralized in the engine, preserves planner safeguards, and avoids retries for roles without explicit continuation semantics.

## Implementation

### Overview

Route `error_transient_transport` through the existing evaluator-family `withRetry()` path by updating default retry policies and adding regression tests for retry, abort-success, non-transient failures, and compile evaluator-family policy coverage.

### Key Decisions

1. Reuse the existing shared retry subtype set in `retry.ts` rather than adding WebSocket string matching outside `harness.ts`. The classifier remains the single source for mapping backend messages to `error_transient_transport`.
2. Limit the policy expansion to evaluator-family roles (`evaluator`, `plan-evaluator`, `cohesion-evaluator`, `architecture-evaluator`) because those roles already use `buildEvaluatorContinuationInput()` and have clean-worktree abort-success semantics.
3. Leave planner `shouldRetry` logic unchanged so transient transport retries remain limited to streams that fail before `planning:submission` or `planning:skip`.
4. Leave `getPolicy()` fallback unchanged so unregistered roles keep a one-attempt, no-retry default.

## Scope

### In Scope

- Add `error_transient_transport` to evaluator-family retry policies through the existing retry subtype constant/helper.
- Keep build evaluator and compile evaluator retries on the existing evaluator continuation input path.
- Add policy assertions for evaluator-family retryable subtypes.
- Add retry-wrapper regression tests for transient evaluator retry, clean-worktree abort-success, and non-transient backend failure behavior.
- Run existing builder/planner transport-resilience tests to confirm no regression in planner submission guards or builder transport handling.

### Out of Scope

- Daemon queue retries or monitor/client API changes.
- New event variants or event schema changes.
- WebSocket string matching in agents, stages, or tests beyond using representative backend error messages as test inputs.
- Blanket retry defaults for reviewer, review-fixer, doc-author, doc-syncer, tester, test-writer, or other unregistered roles.
- Reworking builder-specific post-result downgrade behavior.

## Files

### Create

- None.

### Modify

- `packages/engine/src/retry.ts` — Change `DEFAULT_RETRY_POLICIES.evaluator`, `DEFAULT_RETRY_POLICIES['plan-evaluator']`, `DEFAULT_RETRY_POLICIES['cohesion-evaluator']`, and `DEFAULT_RETRY_POLICIES['architecture-evaluator']` to use the existing max-turns-or-transient retry subtype set. Do not change planner `shouldRetry`, builder policies, sharded builder policies, or `getPolicy()` fallback semantics.
- `test/retry.test.ts` — Extend policy assertions and retry-wrapper tests for evaluator-family transient transport handling. Cover the retry path with remaining unstaged changes, the abort-success path with no remaining unstaged changes, non-transient backend failures, and compile evaluator-family policy coverage.
- `test/pi-transport-resilience.test.ts` — No planned edits; keep in the validation set to prove builder/planner transport-resilience behavior still passes, including planner no-retry after submission.

## Verification

- [ ] `test/retry.test.ts` asserts `DEFAULT_RETRY_POLICIES.evaluator.retryableSubtypes.has('error_transient_transport')`.
- [ ] `test/retry.test.ts` asserts `plan-evaluator`, `cohesion-evaluator`, and `architecture-evaluator` policies include `error_transient_transport` and retain `maxAttempts === 2`.
- [ ] A retry-wrapped build evaluator test with first attempt `Backend error: WebSocket error`, `checkHasUnstagedChanges` returning `true`, and second attempt success observes two attempts, one `agent:retry` event with subtype `error_transient_transport`, one evaluator continuation event, and zero surfaced `plan:build:failed` events.
- [ ] A retry-wrapped evaluator test with `checkHasUnstagedChanges` returning `false` observes one attempt, zero `agent:retry` events, and zero surfaced `plan:build:failed` events.
- [ ] A non-transient backend error test observes one attempt, zero `agent:retry` events, and no `error_transient_transport` terminal subtype.
- [ ] Existing planner tests in `test/pi-transport-resilience.test.ts` still observe a retry before `planning:submission` and no retry after `planning:submission`.
- [ ] Existing `getPolicy()` tests still observe `maxAttempts === 1` and an empty subtype set for unregistered roles.
- [ ] `pnpm type-check` exits with status 0.
- [ ] `pnpm exec vitest run test/retry.test.ts test/pi-transport-resilience.test.ts test/agent-wiring.test.ts` exits with status 0.
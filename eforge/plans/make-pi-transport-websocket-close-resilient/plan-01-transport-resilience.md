---
id: plan-01-transport-resilience
name: Pi Transport Close Resilience
branch: make-pi-transport-websocket-close-resilient/plan-01-transport-resilience
agents:
  builder:
    effort: high
    rationale: This change crosses harness error classification, retry policy
      behavior, build-agent completion handling, and recovery evidence
      synthesis.
  reviewer:
    effort: high
    rationale: Retry and downgrade semantics need careful review to avoid masking
      non-transient backend failures or replaying side-effectful agents without
      evidence.
  tester:
    effort: high
    rationale: Tests must cover event-stream ordering, git evidence, retry
      classification, and recovery DB synthesis.
---

# Pi Transport Close Resilience

## Architecture Context

Pi-backed agents surface some backend transport failures through the agent stream after useful output has already been emitted. The engine currently sees these as plain `Error`s in several paths, so `withRetry` cannot distinguish a retryable transport close from a generic execution failure, and the builder marks plans failed even when the builder result and committed work prove completion.

This plan keeps event schemas as the wire source of truth, keeps provider SDK details inside harnesses, and uses existing retry and `agent:warning` events rather than adding a new event shape.

## Implementation

### Overview

Add a conservative transient transport classifier and a new terminal subtype for retry policy matching. Use it in the Pi harness, retry wrapper, builder error events, pipeline error translation, and recovery synthesis. Add a builder-only post-result downgrade path that requires both `agent:result` evidence and a git commit advancing `HEAD` since the implement attempt started.

### Key Decisions

1. Add `error_transient_transport` to the engine/client terminal subtype union so `withRetry` can emit `agent:retry` with a specific subtype instead of collapsing transient closes into `error_during_execution`.
2. Recognize at least `WebSocket closed 1012`; also recognize the observed Pi message shape `Backend error: WebSocket error` as a transient transport error.
3. Convert transient Pi backend errors to `AgentTerminalError('error_transient_transport', ...)` in `packages/engine/src/harnesses/pi.ts`, while also classifying plain transient `Error`s in `withRetry` and builder catches as a safety net.
4. Downgrade builder implement failures only when the builder emitted `agent:result` and `git rev-parse HEAD` differs from the attempt's starting `HEAD`. Emit `agent:warning` with a stable code such as `transient-transport-downgraded` and then emit the normal implement completion events.
5. Treat transient planner failures as retryable by the planner policy. Reuse the existing dropped-submission continuation reason for prompt context when the transient close occurs before `planning:submission`.
6. Extend recovery event-history synthesis to fall back from `plan:build:failed` to compile-level `phase:end` plus `agent:stop` evidence when no plan-level failure exists.

## Scope

### In Scope

- Transient transport classifier helper and terminal subtype updates in engine and client schema.
- Pi harness conversion of transient backend close messages into typed terminal errors.
- Retry policy updates for planner and builder transient transport failures.
- Builder implement post-result downgrade gated by committed git evidence.
- Build failure event translation for plain transient errors.
- Recovery event-history fallback for compile failures without `plan:build:failed`.
- Unit/integration tests using fake harnesses and real git/monitor DB operations.

### Out of Scope

- Retrying non-transient backend errors.
- Downgrading sharded builder closes that have no committed work evidence.
- Adding new daemon APIs, UI views, or documentation pages.
- Changing Claude SDK terminal subtype behavior beyond accepting the new shared subtype.

## Files

### Create

- `test/pi-transport-resilience.test.ts` — focused coverage for transient classifier behavior, builder post-result downgrade, pre-result classification, non-transient failure behavior, planner `withRetry` continuation, and recovery compile-failure synthesis.

### Modify

- `packages/engine/src/harness.ts` — add `error_transient_transport`, export `isTransientTransportError(message: string): boolean`, and export a small terminal-subtype classifier for thrown values.
- `packages/client/src/events.schemas.ts` — add `error_transient_transport` to `AgentTerminalSubtypeSchema` so `plan:build:failed.terminalSubtype` and `agent:retry.subtype` validate on the wire.
- `packages/engine/src/harnesses/pi.ts` — throw `AgentTerminalError('error_transient_transport', message)` when Pi reports a transient transport close; preserve plain hard failures for non-transient backend errors.
- `packages/engine/src/retry.ts` — classify plain transient transport `Error`s, include `error_transient_transport` in planner and builder retryable subtype sets, and map planner transient continuation context to the existing dropped-submission flow.
- `packages/engine/src/agents/builder.ts` — track builder `agentId`, `agent:result`, and starting `HEAD`; include transient terminal subtype on failure events; downgrade post-result transient builder closes only when `HEAD` advanced; emit `agent:warning` for the downgrade.
- `packages/engine/src/pipeline/error-translator.ts` — include `error_transient_transport` when converting thrown transient errors to `plan:build:failed` events.
- `packages/engine/src/recovery/event-history.ts` — when no `plan:build:failed` exists, synthesize a partial compile failure from the latest failed compile `phase:end` and recent `agent:stop` error, including agent role/id and transient terminal subtype when detectable.
- `test/pipeline-error-translator.test.ts` — add coverage for plain transient errors mapping to `terminalSubtype: 'error_transient_transport'` while generic plain errors still omit a subtype.
- `packages/client/src/__tests__/events-schemas.test.ts` — add schema coverage for `plan:build:failed` and/or `agent:retry` carrying `error_transient_transport`.

## Verification

- [ ] `isTransientTransportError('Backend error: WebSocket closed 1012')` returns `true`.
- [ ] `isTransientTransportError('Backend error: invalid API key')` returns `false`.
- [ ] A builder implement run that commits a file, emits `agent:result`, then throws `Backend error: WebSocket closed 1012` emits `agent:warning` with code `transient-transport-downgraded`, emits `plan:build:implement:complete`, and emits zero `plan:build:failed` events.
- [ ] A builder implement run that throws `Backend error: WebSocket closed 1012` before `agent:result` emits `plan:build:failed` with `terminalSubtype: 'error_transient_transport'` and emits zero `plan:build:implement:complete` events.
- [ ] A builder implement run that emits `agent:result`, commits work, then throws a non-transient backend error emits `plan:build:failed` and emits zero downgrade warnings.
- [ ] A planner run wrapped in `withRetry` that emits `agent:result` then throws `Backend error: WebSocket closed 1012` before `planning:submission` emits `agent:retry` with subtype `error_transient_transport` and completes after a second attempt submits plans.
- [ ] A monitor DB run with failed compile `phase:end` plus planner `agent:stop` error and no `plan:build:failed` produces a recovery summary whose `failingPlan.planId` is `compile`, whose `failingPlan.agentRole` is `planner`, whose error message contains the WebSocket text, and whose `terminalSubtype` is `error_transient_transport`.
- [ ] `pnpm type-check` exits 0.
- [ ] `pnpm test` exits 0.

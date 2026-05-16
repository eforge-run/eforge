---
id: plan-01-policy-gate-foundation
name: Policy Gate SDK, Config, Events, and Runtime Foundation
branch: implement-blocking-policy-gates/plan-01-policy-gate-foundation
agents:
  builder:
    effort: high
    rationale: Adds a public SDK surface, engine registration metadata, config
      defaults, wire event schemas, and a new runtime executor that later plans
      depend on.
  reviewer:
    effort: high
    rationale: Public API and wire-protocol changes need careful API, event-schema,
      and test review.
---

# Policy Gate SDK, Config, Events, and Runtime Foundation

## Architecture Context

Native extension registration is captured by `packages/engine/src/extensions/recorder.ts` and surfaced through `NativeExtensionRegistry`. Engine packages mirror SDK types locally rather than importing `@eforge-build/extension-sdk`. Wire events are owned by `packages/client/src/events.schemas.ts` and every event variant must also be registered in `packages/client/src/event-registry.ts`.

This plan establishes the shared foundation for blocking policy gates without wiring gates into queue dispatch or merge phases yet. Plan 2 consumes the runtime and metadata added here.

## Implementation

### Overview

Add the in-scope policy-gate API methods and context types, capture gate kind/provenance at load time, add policy gate config defaults, define typed policy events, and create an engine runtime that executes policy handlers sequentially with timeout and failure-policy semantics.

### Key Decisions

1. Keep `PolicyGateContext` backward-compatible as the plan-merge context alias. Add `QueueDispatchPolicyGateContext`, `PlanMergePolicyGateContext`, `FinalMergePolicyGateContext`, `AnyPolicyGateContext`, and generic/specialized handler types for new gates.
2. Preserve `beforePlanMerge(handler)` behavior while adding `beforeQueueDispatch(handler)` and `beforeFinalMerge(handler)` to the SDK and recorder.
3. Store policy registrations with `gateKind`, `method`, `registrationIndex`, `extensionName`, `extensionPath`, and handler value. Use registration order for deterministic sequential execution.
4. Default policy gate failures to `fail-closed`; allow `fail-open` via `extensions.policyGateFailurePolicy`. Default `extensions.policyGateTimeoutMs` to `extensions.eventHookTimeoutMs` when omitted.
5. Treat `require-approval` as a blocking decision in the runtime result because no approval workflow exists in this slice.
6. Reject invalid return values and mutation-shaped objects as invalid policy decisions. Under `fail-closed`, emit a failure/timeout event plus a blocking decision event; under `fail-open`, emit the diagnostic and continue.

## Scope

### In Scope

- Public SDK APIs and context types for `beforeQueueDispatch`, `beforePlanMerge`, and `beforeFinalMerge`.
- Engine recorder/type support for three policy gate kinds: `queue-dispatch`, `plan-merge`, and `final-merge`.
- `extensions.policyGateTimeoutMs` and `extensions.policyGateFailurePolicy` parsing, defaults, config merging, and tests.
- New `packages/engine/src/extensions/policy-gate-runtime.ts` with sequential execution, timeout handling, decision validation, failure policy, logger/exec context helpers, read-only context construction, and typed event output.
- Client event schema and registry entries for `extension:policy:decision`, `extension:policy:failed`, and `extension:policy:timeout`.
- Unit tests for SDK exports, loader capture, config defaults/schema, policy runtime decisions/failures/timeouts, and event schema/registry coverage.

### Out of Scope

- Queue scheduler and orchestrator invocation of policy gates. Plan 2 wires the runtime into those call sites.
- Worktree diff computation. Plan 2 adds diff helpers before merge operations.
- Public documentation and examples. Plan 3 updates docs after runtime integration is in place.
- Approval UI/state machine and mutation contracts.

## Files

### Create

- `packages/engine/src/extensions/policy-gate-runtime.ts` — policy-gate runtime executor, decision validation, context builders, timeout/failure-policy handling, and typed diagnostic/decision event creation.
- `test/extension-policy-gate-runtime.test.ts` — unit tests for allow, block, require-approval, invalid return values, thrown errors, timeouts, fail-open, fail-closed, sequencing, and short-circuit behavior.

### Modify

- `packages/extension-sdk/src/api.ts` — add `beforeQueueDispatch` and `beforeFinalMerge`; update `beforePlanMerge` to use the plan-merge handler type and remove deferred-runtime wording from type comments only where the type contract changes.
- `packages/extension-sdk/src/context.ts` — add policy gate kind and gate-specific context types; keep `PolicyGateContext` compatible with existing plan-merge handlers.
- `packages/extension-sdk/src/hooks.ts` — make `PolicyGateHandler` generic over gate context, add specialized handler aliases if useful, and keep `PolicyDecision` as `allow | block | require-approval`.
- `packages/extension-sdk/src/index.ts` — export new context and handler types.
- `packages/engine/src/extensions/types.ts` — add `PolicyGateKind`, policy gate method metadata, `registrationIndex`, and new API shape methods.
- `packages/engine/src/extensions/recorder.ts` — capture `beforeQueueDispatch`, `beforePlanMerge`, and `beforeFinalMerge` registrations with gate kind/method/index; validate handler functions; preserve registration order.
- `packages/engine/src/extensions/index.ts` — export policy runtime functions/types and updated policy registration types.
- `packages/engine/src/config.ts` — add schema, `ExtensionConfig` fields, defaults, and `resolveConfig()` merge logic for `policyGateTimeoutMs` and `policyGateFailurePolicy`.
- `packages/client/src/events.schemas.ts` — add TypeBox variants for policy decision, failure, and timeout events with gate kind, extension provenance, registration index, target identifiers, decision/reason, timeout, and failure policy fields.
- `packages/client/src/event-registry.ts` — add exhaustive registry entries and summaries for new policy events with `scope: 'session'` and `persist: false`.
- `test/config.test.ts` — assert config defaults, event-hook timeout inheritance, explicit policy timeout, valid failure-policy literals, and invalid timeout/failure-policy rejection.
- `test/extension-loader.test.ts` — assert all three gate methods are captured with expected gate kind, method, registration index, extension name, and extension path; assert invalid handler diagnostics for new methods.
- `test/extension-sdk-example.test.ts` — assert new SDK exports compile and examples can reference gate-specific contexts.
- `packages/client/src/__tests__/events-schemas.test.ts` — accept/reject tests for policy events and event registry metadata/summaries.

## Verification

- [ ] `pnpm type-check` exits 0 after SDK, engine, and client type changes.
- [ ] `pnpm test -- test/config.test.ts test/extension-loader.test.ts test/extension-sdk-example.test.ts test/extension-policy-gate-runtime.test.ts packages/client/src/__tests__/events-schemas.test.ts` exits 0.
- [ ] Loader tests observe exactly three policy gate registrations when an extension calls all three methods.
- [ ] Runtime tests observe first blocking or require-approval decision stops later handlers for the same gate invocation.
- [ ] Fail-closed runtime tests emit both a diagnostic event and a blocking policy decision for thrown errors, invalid returns, and timeouts.
- [ ] Fail-open runtime tests emit diagnostics and invoke the next registered handler after thrown errors, invalid returns, and timeouts.
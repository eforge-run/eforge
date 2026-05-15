---
title: Make Pi transport WebSocket close failures resilient
created: 2026-05-14
profile: pi-codex-5-5
---

# Make Pi transport WebSocket close failures resilient

## Problem / Motivation

Pi-backed builds can fail after successful agent output because the OpenAI Codex WebSocket transport closes with a transient service-restart error:

```text
Backend error: WebSocket closed 1012
```

Current behavior still treats this as a hard failure. In the current code path, `packages/engine/src/harnesses/pi.ts` records backend `stopReason='error'`, emits final `agent:usage` and `agent:result`, then throws a plain `Error`. For build agents, `builderImplement` catches it and emits `plan:build:failed` without a retryable `terminalSubtype`, so `withRetry` cannot continue or downgrade the failure.

This PRD itself reproduced a second affected path during compile: the planner emitted `agent:result` summarizing a completed plan set, then `agent:stop` reported `Backend error: WebSocket error`; no `planning:submission`, `planning:complete`, or `plan:build:*` events were emitted, and `withRetry` did not classify the plain `Error`, so the compile phase failed without using planner continuation. Recovery analysis then had poor signal because `packages/engine/src/recovery/event-history.ts` only synthesizes summaries from `plan:build:failed` events and ignored the useful compile-level `agent:stop` / `phase:end` evidence.

## Goal

Make eforge resilient to transient Pi transport failures, especially `WebSocket closed 1012`, without blindly replaying side-effectful coding agents.

Desired behavior:

- If a transient transport close happens after `agent:result` and durable committed work is provable, do not mark the plan failed solely because of the close.
- Emit a clear `agent:warning` diagnostic explaining the transient close was downgraded after completion evidence.
- If the transient close happens before completion evidence, classify it as retryable/continuable and use existing planner/builder continuation retry paths when safe.
- Planner/compile-stage transient transport failures should not bypass `withRetry` as plain unclassified `Error`s.
- Recovery summaries should include enough compile-failure signal to diagnose/retry future transient planner failures, even when no `plan:build:failed` event exists.
- Preserve hard-failure behavior for non-transient backend errors and ambiguous states.

## Implementation guidance

- Add a conservative helper such as `isTransientTransportError(message: string): boolean`, recognizing at least `WebSocket closed 1012`.
- Prefer handling post-result build downgrades in the build-agent/pipeline layer where both `agent:result` evidence and git/durable-work evidence are available.
- Handle pre-submission planner failures in the planner/compile retry layer: a transient Pi transport close after `agent:result` but before `planning:submission` should be classified so existing dropped-submission or continuation retry behavior can run instead of failing the whole compile immediately.
- Existing `agent:warning` events should be used for the downgrade diagnostic unless a genuinely new event shape is required.
- If retry classification needs a new terminal subtype, update both:
  - `packages/engine/src/harness.ts`
  - `packages/client/src/events.schemas.ts` / registry/tests
- Ensure `withRetry` can distinguish retryable transient transport failures from generic `error_during_execution`.

## Files likely to inspect/modify

- `packages/engine/src/harnesses/pi.ts`
- `packages/engine/src/agents/builder.ts`
- `packages/engine/src/retry.ts`
- `packages/engine/src/pipeline/stages/build-stages.ts`
- `packages/engine/src/pipeline/error-translator.ts`
- `packages/engine/src/pipeline/stages/compile-stages.ts`
- `packages/engine/src/agents/planner.ts`
- `packages/engine/src/recovery/event-history.ts`
- `packages/client/src/events.schemas.ts` only if adding/changing event shapes
- Recovery prompt/docs if needed: `packages/engine/src/prompts/recovery-analyst.md`

## Acceptance criteria

- [ ] `WebSocket closed 1012` is classified as a transient transport failure.
- [ ] A simulated builder run that emits `agent:result`, has durable completed work, and then stops with `Backend error: WebSocket closed 1012` does not emit terminal `plan:build:failed` solely because of that close.
- [ ] The same simulated error before `agent:result` remains non-completed and is retried/continued or failed with a retryable/transient classification.
- [ ] A simulated planner/compile run that emits `agent:result` and then stops with a transient Pi WebSocket transport error before `planning:submission` does not hard-fail as an unclassified plain `Error`; it exercises the existing planner retry/continuation path or fails with an explicit retryable/transient classification.
- [ ] Non-transient backend errors still fail the plan/compile phase.
- [ ] The event stream contains a clear `agent:warning` or equivalent diagnostic when eforge downgrades a post-result transient transport close.
- [ ] Recovery analysis has enough signal to recommend retry/continue only when supported by evidence, including compile failures where no `plan:build:failed` event exists.
- [ ] Tests cover post-result transient close, mid-run transient close, and non-transient backend error behavior.
- [ ] `pnpm type-check` exits 0.
- [ ] Relevant tests exit 0.
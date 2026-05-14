---
title: Make Pi transport WebSocket close failures resilient
created: 2026-05-14
depends_on: ["recover-extend-03-typed-event-runtime-from-websocket-close"]
profile: pi-codex-5-5
---

# Make Pi transport WebSocket close failures resilient

## Problem / Motivation

A build failed after the coding agent had already emitted `agent:result` and committed successful work because the Pi/OpenAI Codex WebSocket transport closed with code `1012`:

```text
Backend error: WebSocket closed 1012
```

WebSocket close code `1012` means service restart. This is a transient provider/transport failure, not necessarily a code or plan failure. In the observed run, eforge treated the post-result transport close as a hard plan failure, blocked the dependent plan, and required manual recovery even though the agent result and commit indicated the plan had completed.

Affected users:

- Users running long Pi-backed eforge builds over OpenAI Codex WebSocket transport.
- Dependent PRDs/plans that can be blocked by a transient post-result close.
- Recovery tooling, which must distinguish real implementation failure from transport noise after durable work has landed.

## Goal

Make eforge resilient to transient Pi transport failures, especially `WebSocket closed 1012`, without blindly replaying side-effectful coding agents.

The desired behavior is:

- If a transient transport close happens **after** `agent:result` and after durable work/commit is present, do not immediately mark the plan failed. Verify or classify the plan as completed-with-warning.
- If a transient transport close happens **before** completion/durable work, retry using continuation context where safe.
- Preserve current hard-failure behavior for non-transient backend errors and for ambiguous states where eforge cannot prove work completed.

## Scope

### In scope

- Detect transient Pi transport errors such as `WebSocket closed 1012`.
- Capture enough harness/agent state to know whether an `agent:result` was emitted before the error.
- Detect whether durable work landed, preferably via git state/commit checks already used by the build pipeline.
- Add a safe post-result path that emits warning/diagnostic events instead of `plan:build:failed` when completion is provable.
- Add tests for post-result transient close vs mid-run transient close.
- Update recovery/event-history documentation or prompts if needed so future analysis treats `WebSocket closed 1012` as transient only when there is supporting evidence.

### Out of scope

- Changing Pi or `@earendil-works/pi-ai` transport internals.
- Retrying arbitrary side-effectful tool calls from scratch.
- Treating all WebSocket close codes as safe to ignore.
- Hiding real backend failures that occur before a result or without durable work.

## Implementation guidance

### Error classification

Add a central helper near the Pi harness or build-agent error handling layer, for example:

```ts
isTransientTransportError(message: string): boolean
```

It should initially recognize at least:

- `WebSocket closed 1012`
- optionally equivalent service-restart wording if present in provider errors

Be conservative. Do not classify authentication, quota, model-not-found, policy, or validation errors as transient.

### Post-result handling

The observed failure sequence was:

1. builder generated files and committed work,
2. `agent:usage final: true` emitted,
3. `agent:result` emitted with successful result text,
4. `agent:stop` emitted with `Backend error: WebSocket closed 1012`,
5. builder converted the thrown error into `plan:build:failed`.

Eforge should recognize this pattern and avoid marking the plan failed when durable completion is provable.

Reasonable approaches:

- In the Pi harness, if the backend reports `stopReason='error'` after a complete agent result has already been captured, downgrade transient transport errors to a warning.
- Or in the builder/build pipeline, track whether `agent:result` was seen and whether a commit/worktree completion criterion is satisfied; if so, emit a warning/diagnostic and continue.

Prefer the layer that can best distinguish a genuinely completed coding task from a partial side-effectful run. For builder runs, that likely means the build-agent/pipeline layer rather than the low-level harness alone.

### Mid-run handling

If the same transient close happens before `agent:result` or without durable work:

- do not mark the plan completed,
- classify the failure as retryable/continuable,
- use existing retry/continuation mechanisms where available,
- preserve side effects and avoid starting over blindly.

### Events / diagnostics

Use existing warning/error event patterns if possible. If a new event is needed, add it only in `packages/client/src/events.schemas.ts` and update registry/tests accordingly.

The monitor should make it clear that:

- a transient transport issue occurred,
- eforge verified or inferred completion,
- the plan continued despite the transport close.

## Files likely to inspect/modify

- `packages/engine/src/harnesses/pi.ts`
- `packages/engine/src/agents/builder.ts`
- `packages/engine/src/retry.ts`
- `packages/engine/src/pipeline/stages/build-stages.ts`
- `packages/engine/src/pipeline/error-translator.ts`
- `packages/client/src/events.schemas.ts` only if adding/changing event shapes
- tests around Pi harness mapping, builder failures, retry policy, and monitor/recovery summaries
- recovery prompt/docs if needed (`packages/engine/src/prompts/recovery-analyst.md`, recovery event-history/sidecar code)

## Acceptance criteria

- [ ] `WebSocket closed 1012` is classified as a transient transport failure, not a generic implementation failure.
- [ ] A simulated builder run that emits `agent:result`, has durable completed work, and then stops with `Backend error: WebSocket closed 1012` does not emit terminal `plan:build:failed` solely because of the transport close.
- [ ] The same simulated error before `agent:result` remains non-completed and is retried/continued or failed with a retryable/transient classification.
- [ ] Non-transient backend errors still fail the plan.
- [ ] The monitor/event stream contains a clear warning or diagnostic when eforge ignores/downgrades a post-result transient transport close.
- [ ] Recovery analysis has enough signal to recommend retry/continue for transient transport failures only when supported by evidence.
- [ ] Tests cover post-result transient close, mid-run transient close, and non-transient backend error behavior.
- [ ] `pnpm type-check` exits 0.
- [ ] Relevant tests exit 0.

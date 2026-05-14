---
title: EXTEND_03: Typed event extension runtime
created: 2026-05-14
profile: pi-codex-5-5
---

# EXTEND_03: Typed event extension runtime

## Problem / Motivation

EXTEND_01/02 delivered the native extension foundation: scoped discovery, trust gating, TypeScript/JavaScript loader support, SDK types, registration capture, and CLI/API/Pi/MCP inspection. However, `onEvent(pattern, handler)` registrations are still inert. Extension authors can write and validate event-hook extensions, but their handlers never run during eforge builds.

Affected users:

- Extension authors who expect `eforge.onEvent(...)` examples to work at runtime.
- Teams wanting typed notification, metrics, audit, or status integrations without shell-hook glue.
- Later extension epics that need an execution/runtime pattern for safe hook dispatch.

Why now:

- The roadmap explicitly says typed event hooks are the first native TypeScript runtime capability after SDK + loader.
- Existing docs/examples currently state runtime dispatch is deferred; EXTEND_03 should remove that caveat for `onEvent` only.
- The Schaake OS epic acceptance criteria require typed event handlers, exact/glob matching, safe timeouts/errors, and non-blocking failures.

Evidence sources reviewed:

- `docs/prd/typescript-extensibility.md` defines EXTEND_03 as the first runtime capability: TypeScript `onEvent(pattern, handler)` subscriptions with typed `EforgeEvent`, exact/glob matching, timeout-bounded execution, and non-blocking failure visibility.
- Schaake OS epic `90f25668-7e3c-4e0f-9c5a-8f8bac8d8748` confirms scope and dependencies: EXTEND_03 is critical, in progress, and depends on the SDK/loader foundation epics.
- `docs/roadmap.md` aligns this with the Extensibility roadmap: native TypeScript extensions should start with typed event hooks after SDK + loader.
- Existing foundation is present:
  - `packages/extension-sdk/src/api.ts`, `hooks.ts`, `context.ts`, `events.ts`, and `patterns.ts` expose typed `onEvent`, `EventHookContext`, `EforgeEvent`, and glob helpers.
  - `packages/engine/src/extensions/discovery.ts`, `loader.ts`, `recorder.ts`, `types.ts`, and `projector.ts` discover/load extensions and record `eventHooks` but do not dispatch them.
  - `EforgeEngine.create()` loads the native extension registry and exposes `nativeExtensionRegistry` / `nativeExtensionDiagnostics` in `packages/engine/src/eforge.ts`.
  - CLI/API/Pi/MCP inspection surfaces already report event-hook registration counts (`eforge extension list/show/validate`).
- Existing event-stream middleware patterns to follow:
  - `packages/engine/src/hooks.ts` implements fire-and-forget shell hook matching, timeout/drain, and glob semantics.
  - CLI `wrapEvents()` in `packages/eforge/src/cli/index.ts` and `packages/eforge/src/cli/run-or-delegate.ts` composes session/run IDs, shell hooks, and monitor recording.
  - Daemon watcher composition lives in `packages/monitor/src/server-main.ts::wrapWatcherEvents()` and is tested in `test/daemon-watcher-hooks.test.ts`.
  - Monitor persistence is provided by `packages/monitor/src/recorder.ts::withRecording()`.
- Event schemas are centralized in `packages/client/src/events.schemas.ts`; any new failure/log event variants must be added there rather than hand-defining wire shapes elsewhere.
- Current docs/examples explicitly say runtime dispatch is deferred: `docs/extensions.md`, `docs/extensions-api.md`, `packages/extension-sdk/README.md`, and `examples/extensions/minimal-event-logger.ts` will go stale when EXTEND_03 lands.

## Goal

Implement runtime dispatch for native TypeScript `eforge.onEvent(pattern, handler)` extensions during real eforge runs.

Handlers should receive typed events, match exact/glob patterns, execute with bounded timeouts, expose usable context helpers, surface failures visibly, and never fail or block the underlying build/session by default.

## Approach

### High-level implementation

Implement event hooks as event-stream middleware.

- Add `withNativeEventHooks(events, registry, options)` as an async-generator middleware in `packages/engine/src/extensions/event-runtime.ts`, analogous to shell `withHooks()` in `packages/engine/src/hooks.ts`.
- Consume `NativeExtensionRegistry.eventHooks` / `EventHookRegistration` from `packages/engine/src/extensions/types.ts`.
- Export the runtime from `packages/engine/src/extensions/index.ts`.
- Runtime wiring must be added to each event-consumer path:
  - direct CLI commands in `packages/eforge/src/cli/index.ts`,
  - delegated/daemon CLI paths in `packages/eforge/src/cli/run-or-delegate.ts`,
  - persistent daemon watcher events in `packages/monitor/src/server-main.ts::wrapWatcherEvents()`,
  - queue worker/child execution paths that already go through CLI wrappers.
- Preserve the core rule: engine emits typed events; consumers render/record them.

### Matching semantics

Use exact and glob-style matching with the same semantics as shell hooks and SDK helpers:

- `*` matches any characters.
- Matching is anchored.
- Regex special characters are escaped.
- Patterns such as `*`, `plan:build:*`, and `*:complete` must behave the same as shell hooks and SDK `matchesEventPattern`.
- Precompile event hook patterns once per middleware invocation using the same algorithm as `packages/engine/src/hooks.ts::compilePattern` / SDK `compileEventPattern`.

### Handler execution model

- Dispatch only `registry.eventHooks` in this epic.
- All other extension registration families remain loader-captured/provenance-only.
- When an incoming event matches a hook, schedule the handler asynchronously and yield the original event without waiting for handler completion.
- Original eforge events must continue to be yielded unchanged and promptly.
- Slow handlers must not delay unrelated event processing beyond scheduling overhead.
- Track in-flight handlers and drain briefly at stream teardown.
- At teardown, race `Promise.allSettled(inflight)` against a bounded drain timeout derived from the handler timeout plus grace.
- Use an internal queue/pump so diagnostic events from failures/timeouts can be yielded and recorded without re-feeding those diagnostics into extension matching.

### Timeout behavior

- Bound each handler execution by a timeout.
- Prefer a config-level timeout such as `extensions.eventHookTimeoutMs` if implemented consistently.
- Otherwise use a documented default constant.
- A sensible default example is `5000ms`.
- Do not extend the public `onEvent(pattern, handler)` signature in this epic.
- Timed-out handlers must be terminated/aborted as far as practical and cannot hang the build event stream indefinitely.

### Failure and diagnostic visibility

- Handler errors and timeouts must be visible as logs and/or typed eforge events without failing the underlying build/session by default.
- Add diagnostic event variants only in `packages/client/src/events.schemas.ts` if failure/timeout/log visibility is represented as eforge events.
- Candidate minimal variants:
  - `extension:event-handler:failed` with extension name/path, pattern, triggering event type, and error message/stack if available.
  - `extension:event-handler:timeout` with extension name/path, pattern, triggering event type, and timeoutMs.
  - Optional `extension:event-log` if `ctx.logger` should surface in monitor/SSE rather than stderr only.
- Keep the event set minimal to reduce wire-protocol churn.
- Also log a concise warning/error line to stderr for daemon/CLI logs.
- If events are added, update any event rendering/progress registry only as needed so unknown-looking events are not noisy or invisible.
- Diagnostic events, if added, must be persisted/streamed by the monitor like other events.

### EventHookContext implementation

Construct a fresh `EventHookContext` for each handler invocation.

The context must include:

- `ctx.event`, containing the exact triggering `EforgeEvent`.
- `ctx.logger`, with structured/prefixed debug/info/warn/error behavior.
  - Prefix messages with extension name, pattern, and event type.
  - If an event-log variant is implemented, logger calls should enqueue those events.
  - Otherwise logger writes to stderr.
- `ctx.exec.run(command, args?, options?)`, matching the SDK contract.
  - Use direct `spawn(command, args)` rather than shell-string execution.
  - Capture stdout/stderr/exitCode.
  - Honor cwd/env overrides.
  - Terminate/cancel on handler timeout/abort.
  - Safe output capture and cancellation/timeout behavior must be tied to handler execution.

Existing `packages/engine/src/exec-with-timeout.ts` provides a timeout/process-tree pattern for shell commands, but its API accepts a shell command string rather than command+args. It can inform implementation, but direct `spawn(command, args)` is safer for the SDK contract.

### Middleware ordering

- Apply session/run ID enrichment before event-hook dispatch so handlers receive the same correlated events as monitor/SSE consumers.
- Apply monitor recording after event-hook dispatch so generated diagnostic events are persisted.
- Preserve monitor persistence for extension diagnostic events by composing roughly as:

```ts
event-hook runtime -> recording -> shell hooks
```

or otherwise ensure generated extension diagnostics are recorded.

Known tension:

- The current daemon watcher comment says `withRecording` is inner and `withHooks` is outer.
- Adding extension runtime may change that to `withHooks(withRecording(withNativeEventHooks(events)))` or equivalent.
- Tests/comments should be updated to assert the desired behavior rather than the old two-middleware composition only.

### Code impact

#### Engine extension runtime

- Add a new runtime module under `packages/engine/src/extensions/`, likely `event-runtime.ts`, exported from `packages/engine/src/extensions/index.ts`.
- It should consume `NativeExtensionRegistry.eventHooks` / `EventHookRegistration` from `packages/engine/src/extensions/types.ts` and return an async-generator middleware similar to `withHooks()` in `packages/engine/src/hooks.ts`.
- Matching can reuse `compilePattern`/`matchesPattern` from `packages/engine/src/hooks.ts` or mirror the SDK helper behavior.

#### Context helper implementation

- Implement an event-hook context factory in the engine runtime module:
  - `logger` should include extension name/path and event type in emitted messages.
  - `exec.run()` should spawn the requested executable with args, cwd/env overrides, collect stdout/stderr/exitCode, and terminate on handler timeout/abort.

#### Event schemas / client wire types

- If failure/timeout/log visibility is represented as eforge events, add variants to `packages/client/src/events.schemas.ts` only.
- This follows the project rule that event types and schemas are co-located there.

#### CLI wiring

- Update `wrapEvents()` in `packages/eforge/src/cli/index.ts` to apply native event-hook runtime using `engine.nativeExtensionRegistry` and resolved extension config before monitor recording.
- Because the current helper only receives `hooks`, its signature will need the engine/registry or an options object.
- Update the duplicate wrapper in `packages/eforge/src/cli/run-or-delegate.ts` similarly.
- Ensure `session` and `runId` enrichment happen before event-hook dispatch so handlers receive the same correlated events as monitor/SSE consumers.

#### Daemon watcher wiring

- Update `packages/monitor/src/server-main.ts::wrapWatcherEvents()` to include native event-hook runtime in the persistent watcher path.
- `startWatcher()` already creates an `EforgeEngine`, so it can pass `engine.nativeExtensionRegistry` and timeout config into `wrapWatcherEvents()`.
- Preserve monitor persistence for extension diagnostic events.
- Update `test/daemon-watcher-hooks.test.ts` if composition comments/expectations change.

#### Docs/examples

- Update:
  - `docs/extensions.md`
  - `docs/extensions-api.md`
  - `packages/extension-sdk/README.md`
  - `examples/extensions/minimal-event-logger.ts`
- These should say `onEvent` runtime dispatch is supported.
- Keep `protected-paths.ts` and all non-event APIs marked deferred.

#### Tests

Add focused tests, likely in `test/extension-event-runtime.test.ts` plus wiring updates:

- exact and glob matching dispatch only to matching hooks,
- original events are yielded promptly/unchanged even when handlers are slow,
- handler errors produce visible diagnostics and do not throw from the event stream,
- handler timeout produces visible diagnostics and does not fail the build/session,
- `ctx.event`, `ctx.logger`, and `ctx.exec.run()` are usable,
- disabled/no event hooks is near-zero overhead pass-through,
- daemon watcher composition persists extension diagnostic events.

### Early assumptions / unknowns

- Assumption, medium confidence: event-hook runtime should be an engine-level middleware analogous to shell hooks rather than a build-stage mutation.
  - Evidence: shell hooks already wrap event streams; extension event hooks are specified as TypeScript equivalents of shell hooks.
  - Impact if wrong: programmatic engine callers or daemon worker paths could miss dispatch.
- Assumption, medium confidence: new diagnostic event types for extension handler failure/timeout/logging are acceptable in the shared `EforgeEvent` union.
  - Evidence: project rules require all event wire shapes in `packages/client/src/events.schemas.ts`, and acceptance requires failures be emitted/logged.
  - Impact if wrong: visibility may need stderr-only logging or daemon-event-only records instead.
- Assumption, high confidence: non-event extension registrations (`onAgentRun`, policy gates, tools, profile routers, input sources, reviewer perspectives, validation providers) remain captured-only in this epic.
  - Evidence: PRD task boundaries assign those runtime capabilities to later EXTEND_08+ epics.

### Design decisions

#### 1. Implement event hooks as event-stream middleware

Decision: implement `withNativeEventHooks(events, registry, options)` as an async-generator middleware in `packages/engine/src/extensions/event-runtime.ts`, analogous to shell `withHooks()`.

Rationale:

- Event extensions are TypeScript equivalents of shell hooks, and shell hooks already use event-stream middleware.
- Middleware preserves the core rule: engine emits typed events; consumers render/record them.
- This avoids changing build stages or orchestration internals for a non-blocking observer feature.

Trade-off:

- Runtime wiring must be added to each event-consumer path. This mirrors the current shell hook pattern and is lower-risk than altering every engine method body.

#### 2. Dispatch only `onEvent` registrations in this epic

Decision: only `registry.eventHooks` are executable. All other registration families remain loader-captured/provenance-only.

Rationale:

- PRD phase boundaries intentionally make event hooks the first safe runtime layer.
- Agent context, tools, policy gates, profile routing, input transformers, reviewer perspectives, and validation providers have separate epics with different semantics.

#### 3. Match using the existing shell-hook glob semantics

Decision: precompile event hook patterns once per middleware invocation with the same algorithm as `packages/engine/src/hooks.ts::compilePattern` / SDK `compileEventPattern`.

Rationale:

- Docs already promise event-pattern parity with shell hooks.
- Existing SDK tests validate this behavior, reducing ambiguity.

#### 4. Fire handlers asynchronously and do not block original event delivery

Decision: when an incoming event matches a hook, schedule the handler and yield the original event without waiting for handler completion. Track in-flight handlers and drain briefly at stream teardown.

Rationale:

- PRD says event hooks are non-blocking and failures should not mutate builds by default.
- This preserves shell-hook fire-and-forget behavior while still allowing errors/timeouts to surface.

Implementation note:

- Use an internal queue/pump so diagnostic events from failures/timeouts can be yielded and recorded without re-feeding those diagnostics into extension matching.
- At teardown, race `Promise.allSettled(inflight)` against a bounded drain timeout derived from the handler timeout plus grace.

#### 5. Represent handler failures/timeouts as typed events, plus stderr logging

Decision: add minimal extension runtime diagnostic variants to `EforgeEvent` for handler failure/timeout. Also log a concise warning/error line to stderr for daemon/CLI logs.

Rationale:

- Acceptance explicitly says failures are emitted/logged.
- Typed events make failures visible to monitor/SSE/API consumers and align with the event-owned-by-client rule.
- Stderr alone would not reliably surface in the monitor event history.

Open design detail for implementer:

- Keep the event set minimal to reduce wire-protocol churn. `extension:event-handler:failed` and `extension:event-handler:timeout` are enough for acceptance. Add `extension:event-log` only if `ctx.logger` needs monitor-visible logs in this slice.

#### 6. Handler timeout is global/config-level for now

Decision: use a global default timeout for all event handlers, preferably configurable via `extensions.eventHookTimeoutMs` with a sensible default, such as `5000ms`. Do not extend the public `onEvent()` signature in this epic.

Rationale:

- The SDK contract is already published as `onEvent(pattern, handler)`; adding options would be public API churn.
- A config-level timeout gives operators control without complicating author ergonomics.

#### 7. Context helper behavior

Decision: construct a fresh `EventHookContext` for each handler invocation.

- `ctx.event` is the exact event object that matched.
- `ctx.logger` prefixes messages with extension name, pattern, and event type. If an event-log variant is implemented, logger calls should enqueue those events; otherwise logger writes to stderr.
- `ctx.exec.run(command, args, options)` uses direct process spawning, captures stdout/stderr/exitCode, honors cwd/env overrides, and is tied to the handler abort/timeout controller.

Rationale:

- Fresh context avoids cross-event mutable state leaking through helper objects.
- Direct `spawn(command, args)` matches the SDK signature better than shell-string execution.

#### 8. Middleware ordering

Decision: apply session/run ID enrichment before event-hook dispatch, and apply monitor recording after event-hook dispatch so generated diagnostic events are persisted.

Rationale:

- Extension handlers should see the same correlated events users see in the monitor.
- Diagnostic events must not disappear from persistence/SSE.

Known tension:

- The current daemon watcher comment says `withRecording` is inner and `withHooks` is outer.
- Adding extension runtime may change that to `withHooks(withRecording(withNativeEventHooks(events)))` or equivalent.
- Tests/comments should be updated to assert the desired behavior rather than the old two-middleware composition only.

### Assumptions and validation

| Assumption | Evidence / validation performed | Confidence | Cost to validate further | Validation path | Impact if wrong |
|------------|----------------------------------|------------|--------------------------|-----------------|-----------------|
| EXTEND_01/02 foundation is present and `eventHooks` are captured but not dispatched. | Read `packages/engine/src/extensions/recorder.ts`, `loader.ts`, `types.ts`; tests `test/extension-loader.test.ts` assert event-hook capture; docs say runtime dispatch is deferred. | high | low | Run `pnpm test -- extension-loader` after implementation. | If wrong, implementation may duplicate existing runtime or miss a hidden path. |
| Event-hook runtime should be middleware over event streams, analogous to shell hooks. | Read `packages/engine/src/hooks.ts`, CLI `wrapEvents()` helpers, daemon `wrapWatcherEvents()`, PRD phrase "TypeScript equivalents of shell hooks". | medium | low | During implementation, grep all uses of `withHooks`/`wrapEvents` and add tests for direct CLI and daemon watcher paths. | If wrong, some programmatic engine consumers might expect dispatch inside `EforgeEngine` methods rather than consumer wrappers. |
| New diagnostic events are the best way to satisfy "emitted/logged" failure visibility. | Project rule says event wire shapes live in `packages/client/src/events.schemas.ts`; monitor persists known `EforgeEvent` stream; stderr-only logs are less visible. | medium | low | Add minimal event variants and run type-check/tests; if event surface feels too broad, fall back to `config:warning`/stderr only after review. | Wire-protocol churn if event names/shape are poorly chosen. |
| All real build/queue execution paths pass through CLI/daemon wrappers where middleware can be inserted. | Read `packages/eforge/src/cli/index.ts`, `run-or-delegate.ts`, `packages/monitor/src/server-main.ts`; queue child path spawns CLI `queue exec`. | medium | medium | Grep for direct `engine.compile/build/enqueue/watchQueue` consumption and add a wiring test for missed paths. | Some events could fail to dispatch extensions, especially programmatic API usage or tests using engine directly. |
| Config-level `extensions.eventHookTimeoutMs` is acceptable if timeout configurability is implemented. | Existing config already has `extensions` block; no public `onEvent` options exist. This is a design inference, not a user-stated requirement. | medium | low | Add schema/default/docs/tests; or use a constant if implementer wants zero config surface. | Adding unnecessary config could create docs/reference churn; omitting config may reduce operator control. |
| `ctx.exec.run()` must cancel subprocesses on timeout/abort, not merely race the handler promise. | SDK exposes exec helper; acceptance requires bounded handlers. Read `exec-with-timeout.ts` for existing process-group timeout pattern. | high | medium | Implement direct-spawn exec with AbortSignal/process-tree cleanup and test a long-running command under a short timeout. | Orphaned subprocesses could continue after timed-out extension handlers. |
| Non-event extension registrations remain out of runtime scope. | PRD task boundaries assign them to EXTEND_08+; docs currently mark them deferred. | high | low | Keep tests asserting only `eventHooks` are executed; docs updates only change `onEvent`. | Scope creep could destabilize build orchestration and block EXTEND_03. |

No low-confidence/high-impact assumption remains unresolved. The highest-impact assumption is middleware placement; it has a cheap validation path through grep and wiring tests.

### Profile signal

Recommended profile: **Excursion**.

Rationale: This is a cohesive feature slice spanning engine extension runtime, event schemas, CLI/daemon wiring, tests, and docs. It is cross-cutting but does not require independently delegated module planning. A single planner can enumerate the implementation sequence and dependencies with adequate quality: add the event runtime middleware, wire it into event consumers, add diagnostic event schemas if chosen, then update tests/docs. Expedition would be overkill unless implementation discovers that event dispatch must move inside multiple engine methods rather than the existing wrapper layer.

## Scope

### In scope

1. Implement runtime dispatch for native extension `onEvent(pattern, handler)` registrations captured in `NativeExtensionRegistry.eventHooks`.
2. Support exact and glob-style matching using the same semantics as shell hooks / SDK `matchesEventPattern`:
   - `*` matches any characters,
   - anchored matching,
   - regex special chars escaped.
3. Provide `EventHookContext` runtime helpers for handlers:
   - `ctx.event` containing the triggering `EforgeEvent`,
   - `ctx.logger` with structured/prefixed debug/info/warn/error behavior,
   - `ctx.exec.run(command, args?, options?)` matching the SDK contract, with safe output capture and cancellation/timeout behavior tied to handler execution.
4. Bound each handler execution by a timeout.
   - A config-level timeout such as `extensions.eventHookTimeoutMs` is acceptable if implemented consistently.
   - Otherwise use a documented default constant.
5. Ensure handler errors and timeouts are visible as logs and/or typed eforge events without failing the underlying build/session by default.
6. Wire dispatch into the real event streams used by:
   - direct CLI commands (`packages/eforge/src/cli/index.ts`),
   - delegated/daemon CLI paths (`packages/eforge/src/cli/run-or-delegate.ts`),
   - persistent daemon watcher events (`packages/monitor/src/server-main.ts::wrapWatcherEvents`),
   - queue worker/child execution paths that already go through CLI wrappers.
7. Add tests proving matching, non-blocking dispatch, timeout/error handling, context helper behavior, and daemon/CLI middleware composition.
8. Update docs and examples to mark `onEvent` as runtime-supported while keeping all other capability families deferred.

### Out of scope

- Executing `onAgentRun`, policy gates, profile routers, input sources, reviewer perspectives, validation providers, or custom tool injection.
- Blocking or mutating build lifecycle behavior from event handlers.
- Event replay testing (`eforge extension test`) and static validation beyond existing loader validation.
- `/eforge:extend` authoring UX.
- Trust model changes beyond respecting the existing loader/trust behavior.
- Full extension reload or lifecycle management beyond existing engine/daemon startup behavior.

## Acceptance Criteria

1. Extensions that register `eforge.onEvent(pattern, handler)` are invoked for matching events during real eforge runs.
2. Exact event-type patterns narrow at authoring time through the existing SDK types, and runtime dispatch matches exact patterns correctly.
3. Glob patterns (`*`, `plan:build:*`, `*:complete`, etc.) use the same semantics as shell hooks and SDK `matchesEventPattern`.
4. Handlers receive an `EventHookContext` with:
   - `ctx.event` equal to the triggering event,
   - a usable `ctx.logger`,
   - a usable `ctx.exec.run()` helper matching the SDK signature.
5. Handler execution is timeout-bounded. A timed-out handler is terminated/aborted as far as practical and cannot hang the build event stream indefinitely.
6. Handler errors and timeouts are visible through typed diagnostic events and/or daemon/CLI logs.
7. Non-blocking event hook failures do not cause successful builds/sessions to fail by default.
8. Original eforge events continue to be yielded unchanged and promptly; slow handlers do not delay unrelated event processing beyond scheduling overhead.
9. Extension runtime dispatch is wired into direct CLI, delegated CLI/worker, and persistent daemon watcher paths.
10. Extension diagnostic events, if added, are declared in `packages/client/src/events.schemas.ts` and are persisted/streamed by the monitor like other events.
11. Tests cover matching, non-matching, errors, timeouts, context helpers, pass-through/no-hook behavior, and at least one daemon/CLI middleware wiring path.
12. Documentation and examples are updated so `onEvent` is documented as runtime-supported, while all other extension capability families remain marked deferred.

---
id: plan-02-runtime-wiring-and-docs
name: Runtime Wiring and Documentation
branch: recover-extend-03-typed-event-runtime-from-websocket-close/plan-02-runtime-wiring-and-docs
---

# Runtime Wiring and Documentation

## Architecture Context

Plan 01 restores `withNativeEventHooks()` as reusable event-stream middleware. This plan composes that middleware into every real eforge event consumer covered by the PRD: direct CLI foreground paths, run/delegate in-process paths, queue worker execution through `queue exec`, and the persistent daemon watcher. Event enrichment must run before native dispatch so extension handlers receive correlated `sessionId`/`runId` values. Monitor recording must run after native dispatch so generated `extension:event-handler:*` diagnostics are stored in SQLite and replayable through recorded event streams. Shell hooks remain supported after recording.

Target flow for CLI and daemon streams:

```text
engine events
  -> session/run ID enrichment where applicable
  -> withNativeEventHooks(...)
  -> monitor recording
  -> shell hooks
  -> renderer/consumer
```

## Implementation

### Overview

Wire `withNativeEventHooks()` into CLI and daemon wrapper functions using `engine.nativeExtensionRegistry` and `engine.resolvedConfig.extensions.eventHookTimeoutMs`, update tests for watcher persistence and static wiring, then update docs/SDK comments/examples to state that `onEvent` executes at runtime while all other extension registration families remain deferred.

### Key Decisions

1. Use one wrapper options object per CLI `wrapEvents()` helper instead of adding positional parameters. The object carries `monitor`, `hooks`, and native event runtime options.
2. Compose `withSessionId()`/`runSession()` and `withRunId()` before native dispatch. Native handlers receive the same correlation fields that monitor recording receives.
3. Compose native dispatch before `monitor.wrapEvents()` / `withRecording()`. Handler failure and timeout diagnostics enter SQLite with the triggering run/session correlation.
4. Compose shell hooks after monitor recording. Existing shell-hook behavior remains active, and generated extension diagnostics can flow through shell-hook matching after persistence.
5. Keep non-event extension capabilities deferred in docs, SDK comments, and examples.

## Scope

### In Scope

- Direct CLI event wrapping in `packages/eforge/src/cli/index.ts`.
- Run/delegate event wrapping in `packages/eforge/src/cli/run-or-delegate.ts`.
- Queue worker coverage through the existing `queue exec` wrapper in `packages/eforge/src/cli/index.ts`.
- Persistent daemon watcher composition in `packages/monitor/src/server-main.ts`.
- Daemon watcher test coverage for a throwing native event hook and persisted diagnostic rows.
- Static wiring tests that assert imports/calls/order signals in CLI and daemon files.
- Docs, SDK comments, README, and examples for runtime-supported `onEvent` and deferred non-event capabilities.
- Generated documentation mirrors under `web/content/docs/`, `web/public/docs/`, `web/public/llms.txt`, and `web/public/llms-full.txt` if `pnpm docs:check` reports drift.

### Out of Scope

- Runtime execution for `onAgentRun`, policy gates, custom tools, profile routers, input sources, reviewer perspectives, or validation providers.
- New CLI commands, MCP tools, Pi tools, daemon HTTP routes, or daemon API version changes.
- Monitor-visible event-log variants for `ctx.logger` output.
- General resilience handling for WebSocket close code `1012`.

## Files

### Create

- `test/extension-event-runtime-wiring.test.ts` — optional focused static/runtime wiring tests if keeping all assertions in existing test files makes those files too broad.

### Modify

- `packages/eforge/src/cli/index.ts` — import `withNativeEventHooks`; refactor `wrapEvents()` to accept an options object; compose `withRunId()` before native dispatch, native dispatch before monitor recording, and shell hooks after monitor recording; pass `engine.nativeExtensionRegistry` plus `engine.resolvedConfig.extensions.eventHookTimeoutMs` from enqueue, build queue/watch, queue exec, recover, and apply-recovery paths.
- `packages/eforge/src/cli/run-or-delegate.ts` — mirror the wrapper-options refactor and native runtime composition for in-process enqueue, dry-run compile, foreground runQueue, `queue run`, and watch paths.
- `packages/monitor/src/server-main.ts` — import `withNativeEventHooks`; update `wrapWatcherEvents()` to accept native runtime options; compose `withHooks(withRecording(withNativeEventHooks(events, native.registry, { cwd, timeoutMs: native.timeoutMs }), db, cwd, pid), hooks, cwd)` using the options passed by `startWatcher()`; pass the watcher engine registry/timeout from `startWatcher()`.
- `test/daemon-watcher-hooks.test.ts` — add a watcher test with a native event hook that throws on `phase:start`; collect an `extension:event-handler:failed` event; assert `db.getEventsByType(runId, 'extension:event-handler:failed')` returns one row whose serialized payload contains the extension name, pattern, triggering event type, runId, sessionId, and message; keep existing shell-hook file and run-row assertions passing.
- `test/extension-tooling-wiring.test.ts` — add static checks that `packages/eforge/src/cli/index.ts`, `packages/eforge/src/cli/run-or-delegate.ts`, and `packages/monitor/src/server-main.ts` import and call `withNativeEventHooks`; assert each file references `nativeExtensionRegistry` and `eventHookTimeoutMs`; assert the source order places native dispatch before `monitor.wrapEvents`/`withRecording`.
- `docs/extensions.md` — update runtime support text/table: `onEvent` runtime execution is `Yes`; all non-event rows remain `Deferred`; describe non-blocking dispatch, timeout/failure diagnostics, correlation fields, and shell-hook parity.
- `docs/extensions-api.md` — update the runtime support status table and `onEvent` API narrative to match the implemented runtime; keep non-event capability sections marked deferred.
- `docs/config.md` — document `extensions.eventHookTimeoutMs` in the sample config and native extension field table, including the default value and positive integer semantics.
- `packages/extension-sdk/README.md` — update runtime loading and registration-method tables so `onEvent(pattern, handler)` runtime execution is `Yes` and non-event registrations remain `Deferred`; add a short note on handler failure/timeout diagnostics.
- `packages/extension-sdk/src/api.ts` — update `onEvent` comments/remarks to state runtime support; keep all non-event registration methods marked runtime-deferred.
- `packages/extension-sdk/src/context.ts` — update event-hook context comments to describe runtime-supported `ctx.event`, `ctx.logger`, handler timeout/failure diagnostics, and note that logger output is not a separate monitor event variant in this scope.
- `examples/extensions/minimal-event-logger.ts` — remove the phrase `Event dispatch remains deferred`; state that `onEvent` runs at runtime and handler errors/timeouts emit diagnostics.
- `examples/extensions/protected-paths.ts` — keep a deferred policy-gate runtime note.
- `examples/extensions/README.md` — update the minimal event logger and protected paths runtime notes so event hooks are runtime-supported and policy gates remain deferred.
- `web/content/docs/extensions.md` — update generated mirror if docs generation changes it.
- `web/content/docs/extensions-api.md` — update generated mirror if docs generation changes it.
- `web/content/docs/config.md` — update generated mirror if docs generation changes it.
- `web/public/docs/extensions.md` — update generated mirror if docs generation changes it.
- `web/public/docs/extensions-api.md` — update generated mirror if docs generation changes it.
- `web/public/docs/config.md` — update generated mirror if docs generation changes it.
- `web/public/llms.txt` — update generated aggregate docs if docs generation changes it.
- `web/public/llms-full.txt` — update generated aggregate docs if docs generation changes it.

## Implementation Notes

### CLI wrapper shape

Use a single options object rather than adding positional arguments. A minimal shape is:

```ts
interface WrapEventsOptions {
  monitor: Monitor;
  hooks: readonly HookConfig[];
  native: {
    registry: Pick<NativeExtensionRegistry, 'eventHooks'>;
    timeoutMs: number;
    cwd?: string;
  };
}
```

`wrapEvents()` can then follow this order:

```ts
let wrapped = withRunId(events);
wrapped = withNativeEventHooks(wrapped, opts.native.registry, {
  cwd: opts.native.cwd ?? process.cwd(),
  timeoutMs: opts.native.timeoutMs,
});
wrapped = opts.monitor.wrapEvents(wrapped);
return opts.hooks.length > 0 ? withHooks(wrapped, opts.hooks, process.cwd()) : wrapped;
```

If a call site uses `runSession(...)` before calling `wrapEvents()`, keep that call so `sessionId` enrichment precedes native dispatch. Do not add native runtime options as a fourth or fifth positional parameter.

### Daemon watcher shape

Keep `wrapWatcherEvents()` exported for tests and pass native options from `startWatcher()`:

```ts
const events = wrapWatcherEvents(
  engine.watchQueue(...),
  db,
  cwd,
  process.pid,
  hooks,
  {
    registry: engine.nativeExtensionRegistry,
    timeoutMs: engine.resolvedConfig.extensions.eventHookTimeoutMs,
  },
);
```

Inside the wrapper, native dispatch must wrap the engine stream before `withRecording()` so generated diagnostics are persisted, and before `withHooks()` so shell hooks remain the outer consumer.

## Verification

- [ ] `packages/eforge/src/cli/index.ts` imports `withNativeEventHooks`, calls it inside `wrapEvents()`, and references `engine.nativeExtensionRegistry` plus `engine.resolvedConfig.extensions.eventHookTimeoutMs` at call sites.
- [ ] `packages/eforge/src/cli/run-or-delegate.ts` imports `withNativeEventHooks`, calls it inside `wrapEvents()`, and references `engine.nativeExtensionRegistry` plus `engine.resolvedConfig.extensions.eventHookTimeoutMs` at call sites.
- [ ] `packages/monitor/src/server-main.ts` imports `withNativeEventHooks`, calls it before `withRecording()`, and passes watcher engine registry/timeout from `startWatcher()`.
- [ ] `test/daemon-watcher-hooks.test.ts` includes a throwing native event hook test that collects exactly one `extension:event-handler:failed` event for `phase:start` and persists exactly one row from `db.getEventsByType(runId, 'extension:event-handler:failed')`.
- [ ] Existing daemon watcher shell-hook tests create their hook output files and recorded run rows.
- [ ] Runtime support tables in `docs/extensions.md`, `docs/extensions-api.md`, and `packages/extension-sdk/README.md` contain a `Yes` runtime cell for `onEvent` and `Deferred` runtime cells for every non-event registration family.
- [ ] `examples/extensions/minimal-event-logger.ts` does not contain `Event dispatch remains deferred`.
- [ ] `examples/extensions/protected-paths.ts` contains a deferred policy-gate runtime note.
- [ ] `pnpm test -- test/daemon-watcher-hooks.test.ts test/extension-tooling-wiring.test.ts` exits 0, and the command also includes `test/extension-event-runtime-wiring.test.ts` if that optional file is created.
- [ ] `pnpm type-check` exits 0.
- [ ] `pnpm docs:check` exits 0.

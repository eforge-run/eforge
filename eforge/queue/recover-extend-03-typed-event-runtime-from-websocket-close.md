---
title: Recover EXTEND_03 typed event runtime after transient WebSocket close
created: 2026-05-14
profile: pi-codex-5-5
---

# Recover EXTEND_03 typed event runtime after transient WebSocket close

## Problem / Motivation

The previous `EXTEND_03: Typed event extension runtime` build failed for infrastructure/transport reasons, not because the first implementation plan obviously failed.

Observed failed run:

- Plan set: `extend-03-typed-event-extension-runtime`
- Failed plan reported by monitor: `plan-01-native-event-runtime-foundation`
- Error: `Backend error: WebSocket closed 1012`
- Dependent plan blocked: `plan-02-runtime-wiring-and-docs`
- Landed commit before the transport failure: `ab56e960 feat(plan-01-native-event-runtime-foundation): Native Event Runtime Foundation`
- Feature branch containing the landed work: `eforge/extend-03-typed-event-extension-runtime`

The agent emitted an `agent:result` that said plan 01 was implemented, committed, and verified, then the Pi/OpenAI Codex WebSocket transport closed with code `1012` (service restart). Eforge marked plan 01 failed afterward and blocked plan 02. This recovery PRD should preserve the completed work and finish the remaining runtime wiring/docs plan rather than redoing plan 01 from scratch.

## Goal

Recover and complete EXTEND_03 by preserving the landed plan 01 implementation and executing the remaining plan 02 runtime wiring and documentation work.

After this PRD lands, `EXTEND_03` should be considered complete enough to unblock `EXTEND_04: Extension Management Surface MVP`.

## Critical recovery instructions

1. **Do not redo plan 01 from scratch.** Treat commit `ab56e960` as completed prior work unless verification proves otherwise.
2. Start from the current build branch for this recovery PRD, then bring in the plan 01 commit if it is not already present:
   - Inspect `git show --stat ab56e960`.
   - If the commit is not in the recovery branch history, cherry-pick `ab56e960` or otherwise apply the equivalent changes from branch `eforge/extend-03-typed-event-extension-runtime`.
3. Verify the recovered plan 01 state before continuing:
   - `pnpm --filter @eforge-build/engine build`
   - `pnpm type-check`
   - relevant extension runtime tests if present (`test/extension-event-runtime.test.ts`).
4. Then implement the remaining plan 02 work below.
5. Produce a final commit that includes the recovered plan 01 work plus completed plan 02 work.

## Remaining work: plan 02 runtime wiring and documentation

### Architecture context

Plan 01 created the native event-hook runtime as a reusable event-stream middleware. This recovery must compose that middleware into the real eforge event consumers: direct CLI foreground paths, run-or-delegate in-process paths, queue worker execution, and the persistent daemon watcher. Session/run enrichment must happen before native dispatch, and monitor recording must receive generated extension diagnostic events.

### Implementation overview

Update CLI and daemon wrapper functions to call `withNativeEventHooks()` with `engine.nativeExtensionRegistry` and `engine.resolvedConfig.extensions.eventHookTimeoutMs`. Then update tests and documentation so `onEvent` is documented as runtime-supported while non-event extension capabilities remain deferred.

### Key decisions

1. **Use one wrapper options object in CLI code.** Refactor duplicated `wrapEvents()` helpers to accept native runtime options rather than adding more positional parameters.
2. **Compose enrichment before dispatch.** Keep `withSessionId()` and `withRunId()` before `withNativeEventHooks()` so handlers receive correlated events.
3. **Persist diagnostics.** Compose native runtime before monitor recording in both CLI and daemon paths so failure/timeout diagnostics enter SQLite and SSE replay.
4. **Keep shell hooks supported.** Preserve existing shell-hook behavior while ensuring generated extension diagnostics still flow through monitor recording.
5. **Document event-only runtime support.** Docs and examples must say `onEvent` executes at runtime; every other registration family remains marked `Deferred`.

## Scope

### In scope

- Direct CLI wrapper changes in `packages/eforge/src/cli/index.ts`.
- Run/delegate wrapper changes in `packages/eforge/src/cli/run-or-delegate.ts`.
- Persistent daemon watcher composition in `packages/monitor/src/server-main.ts`.
- Queue worker coverage through the existing CLI `queue exec` wrapper.
- Wiring tests for daemon persistence and static CLI/daemon imports/calls.
- Docs, SDK comments, README, and example updates for `onEvent` runtime support and timeout/failure behavior.

### Out of scope

- Runtime execution for `onAgentRun`, policy gates, tools, profile routers, input sources, reviewer perspectives, or validation providers.
- New CLI commands or MCP/Pi tool changes.
- Daemon HTTP API route changes or API version bump.
- A monitor-visible event-log variant for `ctx.logger`.
- General resilience handling for `WebSocket closed 1012`; that is covered by a separate PRD.

## Files likely to modify

- `packages/eforge/src/cli/index.ts`
- `packages/eforge/src/cli/run-or-delegate.ts`
- `packages/monitor/src/server-main.ts`
- `test/daemon-watcher-hooks.test.ts`
- `test/extension-tooling-wiring.test.ts`
- `test/extension-event-runtime-wiring.test.ts` if a new focused test file is clearer
- `docs/extensions.md`
- `docs/extensions-api.md`
- `docs/config.md`
- `packages/extension-sdk/README.md`
- `packages/extension-sdk/src/api.ts`
- `packages/extension-sdk/src/context.ts`
- `examples/extensions/minimal-event-logger.ts`
- `examples/extensions/README.md`
- generated docs mirrors under `web/content/docs/`, `web/public/docs/`, `web/public/llms.txt`, and `web/public/llms-full.txt` if docs generation reports drift

## Middleware ordering target

Use this event flow for CLI and daemon streams:

```text
engine events
  -> session/run ID enrichment where applicable
  -> withNativeEventHooks(...)
  -> monitor recording
  -> shell hooks
  -> renderer/consumer
```

In daemon watcher code this corresponds roughly to:

```ts
withHooks(
  withRecording(
    withNativeEventHooks(events, engine.nativeExtensionRegistry, { cwd, timeoutMs }),
    db,
    cwd,
    pid,
  ),
  hooks,
  cwd,
)
```

The exact helper shape can differ, but generated `extension:event-handler:*` diagnostics must be inserted into SQLite by `withRecording()` and must not be passed back into native extension matching.

## Acceptance criteria

- [ ] Commit `ab56e960` or equivalent plan 01 changes are preserved in the final recovery branch.
- [ ] Direct CLI `wrapEvents()` and run-or-delegate `wrapEvents()` call `withNativeEventHooks()` after session/run ID enrichment and before monitor recording.
- [ ] Queue `exec` uses the same refactored CLI wrapper and passes `engine.nativeExtensionRegistry` plus `engine.resolvedConfig.extensions.eventHookTimeoutMs`.
- [ ] `wrapWatcherEvents()` composes native event hooks before `withRecording()` and receives the watcher engine registry/timeout from `startWatcher()`.
- [ ] A daemon watcher test with a throwing native event hook collects an `extension:event-handler:failed` event and persists it in monitor storage.
- [ ] Existing shell-hook daemon watcher tests still create hook output files and recorded run rows.
- [ ] Static wiring tests find `withNativeEventHooks` imports/calls in `packages/eforge/src/cli/index.ts`, `packages/eforge/src/cli/run-or-delegate.ts`, and `packages/monitor/src/server-main.ts`.
- [ ] Runtime support tables in `docs/extensions.md`, `docs/extensions-api.md`, and `packages/extension-sdk/README.md` list `onEvent` runtime execution as `Yes` and list all non-event capability rows as `Deferred`.
- [ ] `examples/extensions/minimal-event-logger.ts` no longer contains the phrase `Event dispatch remains deferred`.
- [ ] `examples/extensions/protected-paths.ts` still contains a deferred policy-gate runtime note.
- [ ] `pnpm test -- test/daemon-watcher-hooks.test.ts test/extension-tooling-wiring.test.ts` exits 0, adding `test/extension-event-runtime-wiring.test.ts` if created.
- [ ] `pnpm type-check` exits 0.
- [ ] `pnpm docs:check` exits 0 after docs-site mirrors are regenerated or updated.

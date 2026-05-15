---
id: plan-01-recover-native-event-runtime-foundation
name: Recover Native Event Runtime Foundation
branch: recover-extend-03-typed-event-runtime-from-websocket-close/plan-01-recover-native-event-runtime-foundation
---

# Recover Native Event Runtime Foundation

## Architecture Context

The previous EXTEND_03 run landed commit `ab56e960 feat(plan-01-native-event-runtime-foundation): Native Event Runtime Foundation` on branch `eforge/extend-03-typed-event-extension-runtime`, then the Pi/OpenAI Codex transport closed with WebSocket code `1012`. The recovery branch may or may not already contain that commit in history, so this plan first checks ancestry and only applies the recovered patch when the commit is absent. This plan preserves the completed foundation work without redesigning it, so the follow-up wiring plan can depend on the native event hook middleware, diagnostic event variants, and extension timeout config.

## Implementation

### Overview

Inspect `git show --stat ab56e960 --`, then check whether `ab56e960` is already in the current branch history with `git merge-base --is-ancestor ab56e960 HEAD`. If the commit is already present, leave the recovered foundation state intact and proceed to verification. If the commit is absent, apply the exact patch from `ab56e960` (preferred: `git cherry-pick --no-commit ab56e960` so the eforge plan commit owns the recovered changes) or apply equivalent changes from branch `eforge/extend-03-typed-event-extension-runtime` if cherry-pick mechanics conflict with the build harness. Resolve any drift against current `main` by keeping both the recovered runtime additions and newer current-branch event/schema/UI changes.

### Key Decisions

1. Treat `ab56e960` as completed prior work. Do not reimplement the runtime from scratch and do not alter its public behavior except for conflict resolution required by current HEAD.
2. Keep this plan limited to the foundation patch: native event middleware, diagnostic schemas/registry metadata, default timeout config, display/UI support, and the existing runtime tests. CLI/daemon composition and docs that declare runtime support are handled in plan 02.
3. Preserve current-main changes in shared files such as `packages/client/src/events.schemas.ts`, `packages/client/src/event-registry.ts`, and monitor UI reducer files while adding the recovered `extension:event-handler:*` variants.

## Scope

### In Scope

- Inspect `git show --stat ab56e960 --` before applying the patch.
- Check `git merge-base --is-ancestor ab56e960 HEAD` before applying the patch.
- Apply the plan 01 patch from `ab56e960` or an equivalent patch from `eforge/extend-03-typed-event-extension-runtime` only when the commit is absent from the current branch history.
- Recover `withNativeEventHooks()` and its support types/tests.
- Recover `extensions.eventHookTimeoutMs` config schema/default/merge support.
- Recover typed diagnostic event schemas and event registry entries for `extension:event-handler:failed` and `extension:event-handler:timeout`.
- Recover CLI display and monitor UI handling for extension handler diagnostics.
- Verify the recovered foundation before plan 02 starts.

### Out of Scope

- Wiring native event hooks into CLI, queue, or daemon watcher event streams.
- Updating extension runtime documentation to say `onEvent` executes at runtime.
- Runtime execution for policy gates, agent-run hooks, tools, routers, input sources, reviewer perspectives, or validation providers.
- WebSocket 1012 resilience handling.

## Files

### Create

- `packages/engine/src/extensions/event-runtime.ts` — native event hook middleware, timeout/failure diagnostics, handler context, logger, and `ctx.exec.run` subprocess support.
- `test/extension-event-runtime.test.ts` — focused runtime tests for event ordering, pattern matching, diagnostics, timeouts, context fields, logger output, and subprocess cleanup.

### Modify

- `packages/engine/src/extensions/index.ts` — export `withNativeEventHooks`, runtime defaults, and runtime context/exec option types.
- `packages/engine/src/config.ts` — add `extensions.eventHookTimeoutMs`, default it to `DEFAULT_NATIVE_EVENT_HOOK_TIMEOUT_MS`, merge it from config files, and export the default.
- `packages/client/src/events.schemas.ts` — add TypeBox variants for `extension:event-handler:failed` and `extension:event-handler:timeout`.
- `packages/client/src/event-registry.ts` — add metadata summaries for the two extension handler diagnostics.
- `packages/client/src/__tests__/events-schemas.test.ts` — cover runtime diagnostic event schema acceptance.
- `packages/client/src/__tests__/events-wire-parity.test.ts` — include extension diagnostics in schema/wire parity coverage.
- `packages/eforge/src/cli/display.ts` — render extension handler diagnostics in foreground CLI output.
- `packages/monitor-ui/src/components/timeline/event-card.tsx` — display extension handler diagnostic cards.
- `packages/monitor-ui/src/lib/reducer/index.ts` — account for the new diagnostic event types in reducer dispatch/known-event handling.
- `test/config.test.ts` — update extension config defaults and parsing/merge assertions for `eventHookTimeoutMs`.

## Verification

- [ ] `git show --stat ab56e960 --` exits 0 and lists `packages/engine/src/extensions/event-runtime.ts` plus `test/extension-event-runtime.test.ts`.
- [ ] `git merge-base --is-ancestor ab56e960 HEAD` was checked; if it exited nonzero, the patch from `ab56e960` or equivalent branch changes was applied before verification.
- [ ] `packages/engine/src/extensions/event-runtime.ts` exports `withNativeEventHooks`.
- [ ] `packages/engine/src/config.ts` exposes `extensions.eventHookTimeoutMs` defaulting to `DEFAULT_NATIVE_EVENT_HOOK_TIMEOUT_MS`.
- [ ] `packages/client/src/events.schemas.ts` and `packages/client/src/event-registry.ts` contain `extension:event-handler:failed` and `extension:event-handler:timeout`.
- [ ] `pnpm --filter @eforge-build/engine build` exits 0.
- [ ] `pnpm type-check` exits 0.
- [ ] `pnpm test -- test/extension-event-runtime.test.ts` exits 0.

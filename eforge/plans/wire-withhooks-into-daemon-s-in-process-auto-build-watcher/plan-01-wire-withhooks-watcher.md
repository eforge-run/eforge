---
id: plan-01-wire-withhooks-watcher
name: Wire withHooks into daemon watcher
depends_on: []
branch: wire-withhooks-into-daemon-s-in-process-auto-build-watcher/wire-withhooks-watcher
---

# Wire withHooks into daemon watcher

## Architecture Context

The eforge daemon (`packages/monitor/src/server-main.ts`) runs an in-process auto-build watcher via `engine.watchQueue({ auto: true, abortController })`. The watcher event stream is currently wrapped only in `withRecording(...)` (SQLite persistence). User-configured hooks are not invoked, so `session:start` events emitted from the watcher's parent process at `packages/engine/src/eforge.ts:1236-1240` (and `:1485`) silently bypass the user's hook scripts.

The CLI flows already wire hooks correctly via `wrapEvents` in `packages/eforge/src/cli/index.ts:74-86` and `packages/eforge/src/cli/run-or-delegate.ts`. Child subprocesses likewise get hook wiring (so `session:end`, `agent:start`, `agent:stop`, `agent:tool_use` already fire). Only the parent-side `session:start` for daemon auto-builds is missing.

`withHooks` (`packages/engine/src/hooks.ts:113-172`) is a passthrough async generator middleware: it yields events unchanged and fires matching hooks non-blocking, draining in-flight hooks on teardown using a timeout derived from the configured `hook.timeout` values plus a 1s grace period. Empty `hooks` arrays short-circuit to a passthrough — zero overhead.

`config.hooks` is `readonly HookConfig[]` (defined in `packages/engine/src/config.ts`), loaded from `eforge.config.yaml`/`eforge.config.json` via `loadConfig(cwd)`. In `server-main.ts`, the resolved config is currently loaded at lines 431-438 (after `startWatcher` is declared) and is passed to `startServer(...)` at line 446. The watcher is invoked later via `daemonState.onSpawnWatcher` callbacks, so by the time `startWatcher()` actually runs, `config` is populated in the closure.

## Implementation

### Overview

Wrap the watcher's event stream in `withHooks(...)` after `withRecording(...)`, using the resolved daemon config's hooks. Recording must remain the inner wrapper so persisted events match the stream that hooks observe.

### Key Decisions

1. **Wrap order: `withHooks(withRecording(events, db, cwd, pid), config.hooks, cwd)`** — DB recording happens first (inner), hooks see the same persisted stream (outer). This matches the PRD requirement and keeps DB writes deterministic regardless of hook behavior.
2. **Thread `config` into `startWatcher` via a parameter** — prefer an explicit parameter over relying on closure hoisting. Move the `loadConfig(cwd)` call so the resolved `config` is available before `startWatcher` is called, and pass `config?.hooks ?? []` as an argument. This makes the dependency explicit and avoids the implicit-TDZ readability hazard in the current `let config` placement. Configs continue to be loaded only in persistent mode; in ephemeral mode the daemon never starts the watcher.
3. **Empty-hooks path stays free** — `withHooks` short-circuits to passthrough when `hooks.length === 0`, so projects without configured hooks pay no overhead.
4. **Test via an exported wiring helper** — extract the watcher event-stream composition into a small exported function (e.g. `wrapWatcherEvents(events, db, cwd, pid, hooks)`) so tests can verify the wiring (recording first, hooks second) without spawning a real daemon subprocess. The helper stays in `packages/monitor/src/server-main.ts` and is consumed by `startWatcher`. This keeps the change minimal while making the wiring testable.
5. **Plugin version is NOT bumped** — this change touches `packages/monitor/` and `packages/engine/` test code only; `eforge-plugin/` is unchanged. Confirm during implementation by running `git diff --name-only` against the plan's changeset and verifying no path under `eforge-plugin/` is modified.

## Scope

### In Scope
- Add `withHooks` wrapping inside `startWatcher()` in `packages/monitor/src/server-main.ts`, layered around `withRecording`.
- Thread the resolved daemon `config` (specifically `config.hooks`) into `startWatcher`, either as a parameter or by reordering `loadConfig` to precede `startWatcher`'s definition/use.
- Extract the watcher event-stream wrapping into an exported helper (`wrapWatcherEvents` or similarly named) so the wiring is unit-testable.
- Add a new test in `test/` (either extend `test/hooks.test.ts` with a daemon-watcher section or add a dedicated `test/daemon-watcher-hooks.test.ts`) that:
  - Constructs the same wrap composition the daemon uses (`wrapWatcherEvents`).
  - Feeds an async generator that yields a `session:start` event into the composition.
  - Configures a `session:start` hook whose command writes to a temp file with `EFORGE_EVENT_TYPE` and `EFORGE_SESSION_ID` env vars.
  - Drains the composed generator and asserts the hook output file contains `EFORGE_EVENT_TYPE=session:start` and the expected session id.
  - Asserts the same events are persisted to a temp SQLite DB (via `withRecording`) so we prove recording still happens when hooks are layered on top.
- Confirm the change does not require a plugin version bump.

### Out of Scope
- CLI flow changes — already correctly wired in `packages/eforge/src/cli/index.ts` and `packages/eforge/src/cli/run-or-delegate.ts`.
- Child-subprocess hook flows — already correctly wired by `wrapEvents` in the CLI.
- Refactoring the parent/child split for session events.
- Changes to `withHooks` middleware semantics, event names, or `HookConfig` schema.
- Changes to `eforge-plugin/` (no plugin version bump).
- Daemon subprocess integration tests — the unit-level test of `wrapWatcherEvents` is sufficient to lock the wiring.

## Files

### Create
- `test/daemon-watcher-hooks.test.ts` — new test verifying the daemon watcher's hook dispatch wiring and that DB recording still occurs through the layered composition. (Alternative: extend `test/hooks.test.ts` with a new `describe('daemon watcher wiring', ...)` block; either location is acceptable as long as the test asserts the behavior described in Scope.)

### Modify
- `packages/monitor/src/server-main.ts` — Import `withHooks` from `@eforge-build/engine/hooks`. Move `loadConfig(cwd)` resolution so the daemon `config` is available before `startWatcher` is invoked (or accept it as a parameter). Extract the watcher event-stream wrapping into an exported helper `wrapWatcherEvents(events, db, cwd, pid, hooks)` that returns `withHooks(withRecording(events, db, cwd, pid), hooks, cwd)`. Replace the inline `withRecording(...)` call inside `startWatcher` with `wrapWatcherEvents(engine.watchQueue({ auto: true, abortController: controller }), db, cwd, process.pid, config?.hooks ?? [])`.

## Verification

- [ ] `pnpm type-check` exits with status 0 with no errors.
- [ ] `pnpm test` exits with status 0 and the new daemon-watcher hook test is among the passing tests.
- [ ] The new test's hook-output temp file contains the literal string `EFORGE_EVENT_TYPE=session:start` after the composed generator drains.
- [ ] The new test asserts at least one `session:start` row exists in the temp SQLite DB used by `withRecording`, proving DB recording still runs alongside hooks.
- [ ] Existing `test/hooks.test.ts` cases all pass with no modifications required (or with only additive changes if the new test is colocated there).
- [ ] In `packages/monitor/src/server-main.ts`, `startWatcher`'s event-stream composition is `withHooks(withRecording(...), hooks, cwd)` (recording inner, hooks outer) — verify by reading the file diff.
- [ ] `git diff --name-only` against the plan's changeset shows zero paths under `eforge-plugin/`, confirming no plugin version bump is needed.
- [ ] `withHooks` is imported from `@eforge-build/engine/hooks` in `packages/monitor/src/server-main.ts` (verify via grep on the modified file).
- [ ] When `config?.hooks` is empty or undefined, the watcher behaves identically to today (passthrough): verified by inspection of `withHooks`'s `hooks.length === 0` short-circuit at `packages/engine/src/hooks.ts:118-122`.

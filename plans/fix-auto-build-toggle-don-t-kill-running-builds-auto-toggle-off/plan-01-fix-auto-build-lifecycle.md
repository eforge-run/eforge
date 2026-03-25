---
id: plan-01-fix-auto-build-lifecycle
name: Fix Auto-Build Lifecycle
depends_on: []
branch: fix-auto-build-toggle-don-t-kill-running-builds-auto-toggle-off/fix-auto-build-lifecycle
---

# Fix Auto-Build Lifecycle

## Architecture Context

The daemon spawns `eforge run --queue --watch` as a long-running watcher subprocess. The only way to stop it is SIGTERM, which kills the active build. This plan replaces the long-running `--watch` subprocess with daemon-managed single-cycle spawns so toggling auto-build OFF lets the current build finish, and auto-build auto-toggles OFF when a build starts.

## Implementation

### Overview

Four changes across two files:
1. Remove `--watch` from watcher spawn args (single-cycle execution)
2. Auto-toggle `autoBuild` to `false` immediately after spawning
3. Replace immediate respawn on clean exit with a delayed respawn check, loading `watchPollIntervalMs` from config at startup
4. Fix orphan detection guard to check `watcher.running` instead of `autoBuild`
5. Remove `onKillWatcher()` call in the POST `/api/auto-build` handler when toggling OFF

### Key Decisions

1. **Daemon-managed polling loop** — The daemon spawns `eforge run --queue` (one cycle, exits) and decides whether to respawn based on the `autoBuild` flag. This replaces the subprocess-managed `--watch` loop, giving the daemon fine-grained control over lifecycle.
2. **Auto-toggle OFF on spawn** — Setting `autoBuild = false` immediately after spawning means the UI reflects "OFF" during builds. The user must explicitly re-enable to trigger another cycle. This matches user expectations: "I started a build" != "I want builds forever."
3. **Delayed respawn** — Use `setTimeout` with `watchPollIntervalMs` (from config, default 5000ms) before checking whether to respawn. This prevents tight-looping on empty queues.
4. **No kill on toggle OFF** — When user toggles OFF, just set the flag. The running build finishes its cycle, the exit handler sees `autoBuild === false`, and no respawn occurs. No SIGTERM needed.
5. **Orphan detection uses `watcher.running`** — Since `autoBuild` is now `false` during normal builds, the guard must check `watcher.running` to detect stale watcher state.

## Scope

### In Scope
- `src/monitor/server-main.ts` — spawn args, auto-toggle, respawn delay with config-loaded interval, orphan detection guard
- `src/monitor/server.ts` — remove kill-on-toggle-off in POST `/api/auto-build`

### Out of Scope
- Engine changes (`src/engine/`) — engine stays pure, no daemon awareness
- Monitor UI (`src/monitor/ui/`) — UI already polls, auto-toggle is server-side
- CLI changes — `--watch` flag still exists for direct CLI usage

## Files

### Modify
- `src/monitor/server-main.ts` — (1) Remove `--watch` from spawn args on line 247. (2) Add `daemonState.autoBuild = false;` after line 253 (`watcherProcess = child`). (3) Add module-level `let respawnDelayMs = 5000;` near other module-level vars. (4) In the startup config block (lines 346-358), load `config.prdQueue.watchPollIntervalMs` into `respawnDelayMs`. (5) In the exit handler (lines 300-303), replace immediate `spawnWatcher()` with `setTimeout(() => { if (daemonState.autoBuild && !watcherProcess) { spawnWatcher(); } }, respawnDelayMs);`. (6) In orphan detection (line 372), change guard from `daemonState?.autoBuild` to `daemonState?.watcher.running`. (7) In orphan detection, remove the `spawnWatcher()` respawn call — let the exit handler manage respawns. (8) Remove `updateLockfile` from orphan detection cleanup since the watcher PID is already cleared.
- `src/monitor/server.ts` — In POST `/api/auto-build` handler (lines 949-953), remove the `else` block that calls `options.daemonState.onKillWatcher()`. Replace with a no-op comment or empty block.

## Verification

- [ ] `pnpm build` exits with code 0
- [ ] `pnpm type-check` exits with code 0
- [ ] `pnpm test` exits with code 0
- [ ] `spawnWatcher()` spawns with args `['run', '--queue', '--auto', '--no-monitor']` (no `--watch`)
- [ ] `daemonState.autoBuild` is set to `false` immediately after `watcherProcess = child` in `spawnWatcher()`
- [ ] Exit handler on code 0 uses `setTimeout` with `respawnDelayMs` before checking `daemonState.autoBuild` and `!watcherProcess`
- [ ] `respawnDelayMs` is loaded from `config.prdQueue.watchPollIntervalMs` during startup
- [ ] POST `/api/auto-build` with `{ enabled: false }` does NOT call `onKillWatcher()`
- [ ] Orphan detection guard checks `daemonState?.watcher.running` instead of `daemonState?.autoBuild`
- [ ] Orphan detection does not call `spawnWatcher()` directly

---
id: plan-01-remove-autobuild-reset
name: Remove autoBuild reset in spawnWatcher
depends_on: []
branch: fix-auto-build-to-be-a-persistent-preference/remove-autobuild-reset
---

# Remove autoBuild reset in spawnWatcher

## Architecture Context

The daemon's auto-build feature is driven by `daemonState.autoBuild`. When true, the watcher subprocess is spawned; on clean exit, a delayed respawn re-checks the flag and spawns again (poll-via-respawn). On build failure (non-zero exit), the flag is set to false and a paused event is written. This lifecycle is already implemented correctly — the sole bug is that `spawnWatcher()` unconditionally resets the flag to `false` on every invocation, defeating the respawn loop and the UI toggle.

## Implementation

### Overview

Remove the line `daemonState.autoBuild = false;` (currently line 255) from `spawnWatcher()` in `src/monitor/server-main.ts`. No other changes are needed.

### Key Decisions

1. **One-line removal, not a refactor** — the respawn logic, exit handler, error handler, and API endpoint all function correctly once this reset is removed. No behavioral changes elsewhere are required.

## Scope

### In Scope
- Remove `daemonState.autoBuild = false;` from `spawnWatcher()` in `src/monitor/server-main.ts`

### Out of Scope
- Respawn logic changes
- Exit handler changes
- API endpoint changes
- Any other files

## Files

### Modify
- `src/monitor/server-main.ts` — Remove `daemonState.autoBuild = false;` (line 255) from the `spawnWatcher()` function

## Verification

- [ ] `pnpm build` exits with code 0
- [ ] `pnpm type-check` exits with code 0
- [ ] The string `daemonState.autoBuild = false` does NOT appear inside the `spawnWatcher` function body (it must still appear in the error handler and exit handler)
- [ ] `spawnWatcher()` sets `watcherProcess`, `daemonState.watcher`, and calls `updateLockfile` but does not mutate `daemonState.autoBuild`

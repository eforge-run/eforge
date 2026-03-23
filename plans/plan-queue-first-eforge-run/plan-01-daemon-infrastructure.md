---
id: plan-01-daemon-infrastructure
name: Daemon Infrastructure — Config, Client, Watcher, API
depends_on: []
branch: plan-queue-first-eforge-run/daemon-infrastructure
---

# Daemon Infrastructure — Config, Client, Watcher, API

## Architecture Context

This plan establishes the foundation for queue-first execution: a new `prdQueue.autoBuild` config option, a shared daemon client module extracted from `mcp-proxy.ts`, the watcher subprocess lifecycle in the daemon, and HTTP API endpoints for auto-build state. All subsequent plans depend on these primitives.

## Implementation

### Overview

Four changes that together make the daemon capable of auto-building PRDs from the queue:

1. **Config**: Add `autoBuild` to `prdQueue` schema/defaults/merge
2. **Daemon client**: Extract `ensureDaemon`, `daemonRequest`, `sleep`, and constants from `mcp-proxy.ts` into a shared `daemon-client.ts`
3. **Watcher lifecycle**: Spawn/kill/respawn a `eforge run --queue --watch --auto --no-monitor` subprocess in `server-main.ts`, with `DaemonState` interface for runtime toggle
4. **HTTP API**: `GET/POST /api/auto-build` endpoints and enrich `POST /api/enqueue` response with `autoBuild` field

### Key Decisions

1. **Watcher is a subprocess, not inline engine code** — keeps the daemon a thin coordinator. The watcher runs `eforge run --queue --watch --auto --no-monitor` which already handles all queue processing logic.
2. **`autoBuild` is a runtime toggle** — reads from config on startup, `POST /api/auto-build` changes in-memory state only. Persistent changes require editing `eforge.yaml`.
3. **Build failure pauses auto-build** — watcher exit code distinguishes intentional stop (0 + killed by us) from build failure (non-zero). On failure, auto-build pauses and a `daemon:auto-build:paused` event is written to SQLite.
4. **Respawn on clean exit** — if the watcher exits cleanly (exit code 0) and wasn't killed intentionally, respawn it to keep watching.
5. **DaemonState passed to server** — `startServer()` options gain an optional `daemonState` field alongside existing `workerTracker`.

## Scope

### In Scope
- `prdQueue.autoBuild` Zod schema field, type, default (`true`), merge logic
- New `src/cli/daemon-client.ts` with `ensureDaemon`, `daemonRequest`, `sleep`, `DAEMON_START_TIMEOUT_MS`, `DAEMON_POLL_INTERVAL_MS`
- Update `mcp-proxy.ts` to import from `daemon-client.ts` (remove local definitions)
- `DaemonState` interface in `server-main.ts`
- Watcher subprocess spawn/kill/respawn in persistent mode
- Orphan timer extended to check watcher health
- `killWatcher()` in shutdown handler
- `GET /api/auto-build` → `{ enabled, watcher: { running, pid, sessionId } }`
- `POST /api/auto-build` with `{ enabled: boolean }` → toggle + spawn/kill watcher
- `POST /api/enqueue` response enriched with `autoBuild` field
- `daemon:auto-build:paused` event written to SQLite on build failure

### Out of Scope
- CLI command rename (plan-02)
- MCP tool rename (plan-02)
- Plugin skill changes (plan-02)
- Documentation updates (plan-03)

## Files

### Create
- `src/cli/daemon-client.ts` — Shared daemon client: `ensureDaemon(cwd)`, `daemonRequest(cwd, method, path, body?)`, `sleep(ms)`, constants

### Modify
- `src/engine/config.ts` — Add `autoBuild: z.boolean().optional()` to prdQueue Zod schema (~line 190), add `autoBuild: boolean` to EforgeConfig prdQueue type (~line 221), set default `true` in DEFAULT_CONFIG (~line 277), add to merge logic in `loadConfig` (~line 347) and `mergePartialConfigs` (~line 452)
- `src/cli/mcp-proxy.ts` — Remove local `ensureDaemon`, `daemonRequest`, `sleep`, `DAEMON_START_TIMEOUT_MS`, `DAEMON_POLL_INTERVAL_MS` definitions (lines 14-112). Import them from `./daemon-client.js`. Keep `sanitizeFlags`, `ALLOWED_FLAGS`, `runMcpProxy`, and all tool definitions unchanged.
- `src/monitor/server-main.ts` — After `writeLockfile` (~line 187) in persistent mode: load config to read `autoBuild`, create `DaemonState` object, call `spawnWatcher()` if autoBuild enabled. Extend orphan timer to check watcher health. Add `killWatcher()` call in `shutdown()` before `removeLockfile`. Pass `daemonState` to `startServer()`.
- `src/monitor/server.ts` — Add optional `daemonState` to `startServer` options type. Add `GET /api/auto-build` and `POST /api/auto-build` route handlers (503 if no daemonState). Enrich `POST /api/enqueue` response to include `autoBuild` field from daemonState.

## Verification

- [ ] `pnpm type-check` passes with zero errors
- [ ] `pnpm test` — all existing tests pass
- [ ] `pnpm build` completes with exit code 0
- [ ] `src/cli/daemon-client.ts` exports `ensureDaemon`, `daemonRequest`, and `sleep`
- [ ] `src/cli/mcp-proxy.ts` imports `ensureDaemon` and `daemonRequest` from `../cli/daemon-client.js` (no local definitions)
- [ ] `src/engine/config.ts` `DEFAULT_CONFIG.prdQueue.autoBuild` equals `true`
- [ ] `GET /api/auto-build` returns `{ enabled: boolean, watcher: { running: boolean, pid: number | null, sessionId: string | null } }` when daemon is active, and 503 when not
- [ ] `POST /api/auto-build` with `{ enabled: true }` spawns the watcher; `{ enabled: false }` kills it
- [ ] `POST /api/enqueue` response includes an `autoBuild` boolean field
- [ ] Watcher process is spawned after lockfile write when `autoBuild` is `true` in persistent mode
- [ ] Watcher is killed during daemon shutdown before lockfile removal
- [ ] Non-zero watcher exit sets autoBuild to `false` and does NOT respawn
- [ ] Clean watcher exit (code 0, not killed by daemon) respawns the watcher if autoBuild is still enabled

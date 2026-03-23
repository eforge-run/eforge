---
id: plan-01-daemon-infrastructure
name: Daemon Infrastructure
depends_on: []
branch: eforge-daemon-mcp-server-architecture/daemon-infrastructure
---

# Daemon Infrastructure

## Architecture Context

The existing monitor (`src/monitor/`) is a detached process with an auto-shutdown state machine (WATCHING → COUNTDOWN → SHUTDOWN) designed for ephemeral use — it spins up per-build and shuts down when idle. This plan evolves it into a persistent per-project daemon that stays alive until explicitly stopped, adds control-plane HTTP POST routes for launching/cancelling builds, and adds `eforge daemon start|stop|status` CLI commands.

The daemon is a **coordinator, not an orchestrator** — engine execution stays in worker processes. The daemon manages the HTTP server, SQLite DB, SSE delivery, and worker process lifecycles. Workers use `--no-monitor` (records to SQLite, no server) and the daemon serves their events.

## Implementation

### Overview

1. **Make `server-main.ts` support persistent mode** — add a `--persistent` flag that disables the auto-shutdown state machine. When persistent, the server stays alive until SIGTERM/SIGINT. The flag is passed as a 4th CLI argument.
2. **Rename lockfile to `daemon.lock`** with backward compat — check both `daemon.lock` and `monitor.lock` during reads, write only `daemon.lock`.
3. **Add control-plane POST routes** to `server.ts` — `POST /api/run`, `POST /api/enqueue`, `POST /api/cancel/:sessionId`, `POST /api/queue/run`, `GET /api/config/show`, `GET /api/config/validate`. POST routes spawn worker processes via a new `spawnWorker()` function.
4. **Add `eforge daemon` CLI subcommands** — `start`, `stop`, `status` in `src/cli/index.ts`.
5. **Update `ensureMonitor()` in `index.ts`** to check both lockfile names and gain daemon awareness.

### Key Decisions

1. **Persistent mode is opt-in via `--persistent` arg** rather than a config change — this preserves backward compat. The existing auto-shutdown behavior is the default. `eforge daemon start` passes `--persistent`, CLI `eforge run` does not. This means zero change to existing CLI workflow.
2. **Worker spawning uses `spawn('eforge', ...)` not `fork()`** — workers are full CLI processes that need their own Commander setup, signal handling, and `--no-monitor` flag. `spawn()` with `detached: true` + `stdio: 'ignore'` + `unref()` lets them outlive the daemon if needed.
3. **POST routes parse JSON body manually** via `req.on('data')` aggregation — no Express dependency. Consistent with the existing raw `http.createServer` pattern in `server.ts`.
4. **Worker PID tracking is in-memory** (`Map<string, number>`) keyed by sessionId — the DB `runs.pid` column already persists PIDs for orphan detection, so the in-memory map is just for fast cancellation lookup. When the daemon restarts, it discovers active workers via DB `getRunningRuns()`.
5. **Backward compat lockfile strategy**: `readLockfile()` tries `daemon.lock` first, falls back to `monitor.lock`. `writeLockfile()` always writes `daemon.lock`. This means old servers writing `monitor.lock` are still detected, and new servers write the new name.
6. **`eforge daemon stop` sends SIGTERM** to the daemon PID from the lockfile — the daemon's existing SIGTERM handler performs clean shutdown (clear timers, remove lockfile, close DB, close SSE, exit).

## Scope

### In Scope
- Persistent mode in `server-main.ts` (skip state machine when `--persistent`)
- Lockfile rename with backward compat
- Control-plane POST routes with JSON body parsing
- Worker spawner function in `server.ts`
- `eforge daemon start|stop|status` CLI commands
- CORS headers on all POST routes (preflight OPTIONS handling)
- Orphan detection covers daemon-spawned workers (unchanged — already works via PID check)

### Out of Scope
- MCP proxy and tool definitions (Plan 02)
- Plugin skill migration (Plan 02)
- Cancel support via MCP (Phase 2 — POST /api/cancel/:sessionId is wired but cancel via MCP is Phase 2)
- Queue auto-build with `--watch` via daemon (deferred to Phase 2)
- Web UI start/cancel buttons (Phase 2)
- IPC channel for re-guidance (Phase 3)

## Files

### Modify
- `src/monitor/server-main.ts` — Add `--persistent` mode flag (4th arg). When set, skip state machine timers entirely (no `stateTimer`), keep only orphan detection timer. Remove countdown-related logic behind a guard. Keep SIGTERM/SIGINT handlers for clean shutdown. Update module docstring.
- `src/monitor/lockfile.ts` — Change `LOCKFILE_NAME` to `'daemon.lock'`. Add `LEGACY_LOCKFILE_NAME = 'monitor.lock'`. Update `readLockfile()` to try daemon.lock first, fall back to monitor.lock. `writeLockfile()` writes daemon.lock only. `removeLockfile()` removes both names (cleanup legacy). Export `LOCKFILE_NAME` for tests.
- `src/monitor/server.ts` — Add JSON body parser helper (`parseJsonBody(req): Promise<unknown>`). Add `POST /api/run` route that calls `spawnWorker('run', body.source, body.flags)`, returns `{ sessionId }`. Add `POST /api/enqueue` route. Add `POST /api/cancel/:sessionId` route (looks up PID, sends SIGTERM, updates DB status). Add `POST /api/queue/run` route. Add `GET /api/config/show` and `GET /api/config/validate` routes. Add CORS preflight (OPTIONS) handling for all POST routes. Accept `cwd` and optional `workerTracker` in `startServer()` options for worker management. The `workerTracker` is an object with `spawnWorker()` and `cancelWorker()` methods — `server-main.ts` creates it and passes it in.
- `src/monitor/index.ts` — Update `ensureMonitor()` to work with new lockfile name (no code change needed since it calls `readLockfile()` which handles fallback). Update `signalMonitorShutdown()` similarly. No functional changes — lockfile.ts handles the dual-name logic.
- `src/cli/index.ts` — Add `daemon` subcommand group with `start`, `stop`, `status` commands. `start`: spawn detached server-main with `--persistent` flag, wait for lockfile, print URL. `stop`: read lockfile, send SIGTERM, wait for lockfile removal. `status`: read lockfile, health check, print info (port, PID, uptime, running builds count from DB).

## Verification

- [ ] `eforge daemon start` from project root creates `.eforge/daemon.lock` and `GET /api/health` responds with `{ status: 'ok' }` on the advertised port
- [ ] `eforge daemon status` prints port, PID, and uptime when daemon is running; prints "not running" when daemon is stopped
- [ ] `eforge daemon stop` removes `.eforge/daemon.lock`, and the daemon process exits within 5 seconds
- [ ] `POST /api/run` with `{ "source": "test.md" }` returns `{ "sessionId": "<uuid>" }` and a worker process is spawned (visible via `ps aux | grep eforge`)
- [ ] `POST /api/enqueue` with `{ "source": "test.md" }` spawns an enqueue worker and returns a result
- [ ] `POST /api/cancel/:sessionId` sends SIGTERM to the worker PID and the run's DB status is updated to 'killed'
- [ ] `GET /api/config/show` returns JSON with the resolved eforge config
- [ ] `GET /api/config/validate` returns `{ "valid": true }` or `{ "valid": false, "errors": [...] }`
- [ ] `POST /api/queue/run` spawns a queue-processing worker
- [ ] Existing CLI workflow (`eforge run prd.md` without daemon) still works — `ensureMonitor()` spawns ephemeral monitor with auto-shutdown
- [ ] With daemon running, `eforge run prd.md` reuses the daemon's server (events appear in daemon's SSE stream)
- [ ] Daemon reads both `.eforge/daemon.lock` and `.eforge/monitor.lock` during lockfile detection (backward compat)
- [ ] Daemon-spawned workers use `--no-monitor` flag (confirmed via process args)
- [ ] Orphan detection marks dead worker PIDs as 'killed' in DB
- [ ] `pnpm type-check` passes
- [ ] `pnpm test` passes
- [ ] `pnpm build` succeeds

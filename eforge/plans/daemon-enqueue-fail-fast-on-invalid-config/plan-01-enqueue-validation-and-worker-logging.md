---
id: plan-01-enqueue-validation-and-worker-logging
name: Enqueue Config Validation and Worker Log Capture
depends_on: []
branch: daemon-enqueue-fail-fast-on-invalid-config/enqueue-validation-and-worker-logging
---

# Enqueue Config Validation and Worker Log Capture

## Architecture Context

The daemon's `/api/enqueue` endpoint in `server.ts` spawns a detached worker process via `workerTracker.spawnWorker()` (defined in `server-main.ts`) with `stdio: 'ignore'`. If the worker crashes due to config issues (e.g., missing `backend` field), the error is silently lost and the caller receives a fake success response. This plan adds pre-spawn config validation and worker log capture as defense-in-depth.

## Implementation

### Overview

Two changes:
1. Add config validation to the `/api/enqueue` endpoint so it returns an HTTP error before spawning if config is invalid (missing `backend`).
2. Redirect worker stdout/stderr to a log file in `.eforge/` so that unexpected worker failures are diagnosable.

### Key Decisions

1. **Pass loaded config through `startServer` options** rather than re-loading in the request handler. The config is already loaded at daemon startup (line 372 of `server-main.ts`). Add an optional `config` field to the `startServer` options object and pass it through from `server-main.ts`. This avoids async file I/O in the hot path and guarantees consistency with the daemon's own config view.
2. **Validate `backend` field specifically** - not a full `validateConfigFile()` call. The backend field is the critical requirement for enqueue/build to work. The existing `loadConfig()` already handles YAML parsing and schema validation; what's missing is the check that `backend` is defined. Check `config.backend` is truthy; if not, return 422 with a clear error message.
3. **Log file per worker session** at `.eforge/worker-<sessionId>.log` rather than a shared append log. Per-session logs are easier to correlate with specific failures and avoid interleaved output from concurrent workers.
4. **Ensure `.eforge/` directory exists** before opening the log file. Use `mkdirSync` with `recursive: true` since this is a synchronous operation in the spawn path.
5. **Apply config validation to both `/api/enqueue` and `/api/run`** endpoints since both spawn workers that will fail the same way on missing backend. The PRD focuses on enqueue but the same silent failure affects `/api/run`.
6. **Fix `autoBuild` in enqueue response** - currently `options.daemonState?.autoBuild ?? false` reads from `daemonState` which IS updated from config at startup (line 374), so this already reflects the actual config value. Verify this is correct and no change needed.

## Scope

### In Scope
- Config validation in the `/api/enqueue` endpoint handler (`server.ts`)
- Config validation in the `/api/run` endpoint handler (`server.ts`) - same issue
- Adding `config` field to `startServer` options interface (`server.ts`)
- Passing loaded config from `server-main.ts` to `startServer`
- Worker stderr/stdout capture to `.eforge/worker-<sessionId>.log` in `spawnWorker()` (`server-main.ts`)
- Creating `.eforge/` directory if it doesn't exist before writing log files

### Out of Scope
- Changes to MCP proxy layer (`daemon-client.ts`, `mcp-proxy.ts`)
- Changes to enqueue engine logic (`eforge.ts`, `prd-queue.ts`)
- New API endpoints or CLI commands
- Changes to `loadConfig()` or config schema

## Files

### Modify
- `src/monitor/server.ts` - Add optional `config` field (typed as `Pick<EforgeConfig, 'backend'>`) to the `startServer` options parameter. In the `/api/enqueue` handler (line 1034), add a config validation check before `spawnWorker()`: if `options.config` exists and `options.config.backend` is falsy, return 422 with error message `"No backend configured. Set backend: claude-sdk or backend: pi in eforge/config.yaml"`. Apply the same check to the `/api/run` handler (line 1014). Import `EforgeConfig` type from `../engine/config.js`.
- `src/monitor/server-main.ts` - (1) Move the `loadConfig(cwd)` call (currently at line 372, after `startServer`) to BEFORE the `startServer` call (line 349). Store the result in a `config` variable (or `undefined` if the load fails). Pass it as `config` in the `startServer` options. The autoBuild/watcher/idle-shutdown setup at line 370-384 should read from this same variable instead of calling `loadConfig` a second time. (2) In `spawnWorker()` (line 145): import `openSync`, `closeSync`, `mkdirSync` from `node:fs`. Before spawning, create `.eforge/` directory with `mkdirSync(resolve(cwd, '.eforge'), { recursive: true })`. Open a log file at `.eforge/worker-<sessionId>.log` via `openSync`. Change `stdio: 'ignore'` to `stdio: ['ignore', logFd, logFd]` (stdin ignored, stdout+stderr to log file). Close the fd after spawn with `closeSync(logFd)` since the child process has inherited it.

## Verification

- [ ] `POST /api/enqueue` returns HTTP 422 with body containing `"No backend configured"` when `eforge/config.yaml` has no `backend` field
- [ ] `POST /api/run` returns HTTP 422 with the same error when `backend` is missing
- [ ] `POST /api/enqueue` returns HTTP 200 with `sessionId`, `pid`, and `autoBuild` when config has a valid `backend`
- [ ] Spawned worker processes write stdout/stderr to `.eforge/worker-<sessionId>.log`
- [ ] `.eforge/` directory is created if it doesn't exist before writing log files
- [ ] `pnpm type-check` passes with no errors
- [ ] `pnpm test` passes with no regressions

---
title: eforge Daemon + MCP Server Architecture
created: 2026-03-23
status: pending
---

# eforge Daemon + MCP Server Architecture

## Problem / Motivation

Multiple Claude Code sessions currently interact with eforge through CLI delegation (plugin skills shell out to `eforge run`, `eforge enqueue`, etc.) or direct file reads (`.eforge/state.json`). This works but provides:

- **No coordination between sessions** — multiple Claude Code sessions in the same project have no shared view of what's running
- **No real-time feedback through MCP** — skills must poll files or parse CLI output rather than receiving structured tool responses
- **No control-plane operations** — cannot cancel builds, re-guide in-progress work, or manage queues from within a Claude Code session
- **Fragile session lifecycle** — the current monitor auto-shuts down via a countdown state machine (WATCHING → COUNTDOWN → SHUTDOWN), which is inappropriate for a coordination hub that multiple sessions depend on

## Goal

Evolve the existing per-project monitor into a persistent local daemon with an MCP server interface, enabling multi-session coordination, real-time build status, and control-plane operations (launch, cancel, queue management) — all accessible as MCP tools from any Claude Code session in the project.

## Approach

### Key Architecture Decision: Coordinator, Not Orchestrator

The daemon remains a **coordinator** (tracks state, exposes tools, launches workers) rather than becoming the **orchestrator** (running the engine itself). Reasons:

- Engine manipulates filesystem and git — needs project-level cwd, credentials, PATH
- Agent SDK spawns subprocesses that need project context (`.mcp.json`, CLAUDE.md)
- `AsyncGenerator<EforgeEvent>` pattern is designed for in-process consumption
- The current decoupled recording (`withRecording()` → SQLite) already enables multi-process coordination

**The daemon is a multiplexer**: it manages per-project SQLite databases, serves the web UI, handles MCP tool routing, and manages worker process lifecycles. Engine execution stays in worker processes.

### Overall Architecture

```
Claude Code Session(s)
    |
    | MCP (stdio — proxy auto-starts daemon)
    |
+---v--------------------------+
| eforge-mcp-proxy (stdio)     |  spawned by Claude Code per session
| Connects to daemon via HTTP  |
+---+--------------------------+
    |
    | HTTP (localhost:4567)
    |
+---v--------------------------+
| eforge daemon                |  persistent local process
| ├─ HTTP API (existing + new) |
| ├─ SQLite (per-project DBs)  |
| ├─ Worker launcher           |  spawns CLI processes for builds
| ├─ Session registry          |  tracks what's running where
| └─ Web monitor UI            |
+------------------------------+
    |
    | fork() / spawn()
    |
+---v--------------------------+
| eforge run ... (worker)      |  CLI process in project cwd
| ├─ EforgeEngine              |
| ├─ withRecording() → SQLite  |
| └─ Agent SDK subprocesses    |
+------------------------------+
```

### MCP Transport: Stdio Proxy

Claude Code plugins declare MCP servers via `.mcp.json` at plugin root. Two transport options were considered:

1. **`type: "stdio"`** — Claude Code spawns a Node.js proxy script that auto-starts the daemon and bridges stdio MCP to HTTP calls. Most robust: handles daemon lifecycle transparently.
2. **`type: "http"`** — Points directly to `http://localhost:4567/mcp`. Simpler but fragile: fails silently if daemon isn't running.

**Decision: stdio proxy.** The proxy is tiny (~150 lines), auto-starts the daemon, and provides graceful error handling. Uses `@modelcontextprotocol/sdk` for the MCP server implementation.

Plugin `.mcp.json`:
```json
{
  "mcpServers": {
    "eforge": {
      "type": "stdio",
      "command": "node",
      "args": ["./mcp/eforge-mcp-proxy.js"]
    }
  }
}
```

### Daemon Design: Per-Project

The daemon is **per-project** — one daemon process per repository, running at the project root. This is a natural evolution of the current per-project monitor: same lockfile location, same DB, same cwd-scoped HTTP server. The daemon is just the monitor made persistent with control-plane routes added.

Benefits of per-project scoping:
- No multi-project DB management or routing
- No `project` parameter on every HTTP route
- No global lockfile coordination
- Lockfile, DB, and server all scoped to one project — same as today
- Multiple Claude Code sessions in the same project share one daemon
- Different projects get independent daemons on different ports

### Daemon Lifecycle

Evolve the existing monitor (`src/monitor/server-main.ts`):

- **Remove auto-shutdown state machine** (WATCHING → COUNTDOWN → SHUTDOWN). Replace with persistent mode: stays alive until explicit `eforge daemon stop` or SIGTERM.
- **Lockfile stays per-project** at `.eforge/daemon.lock` (rename from `monitor.lock` for clarity, keep backward compat check).
- **Single-project DB**: One `MonitorDB` at `.eforge/monitor.db` (unchanged from today).
- **Auto-start**: First client that needs it spawns it (same `fork()` + lockfile pattern as current `ensureMonitor()`).
- **CLI**: `eforge daemon start|stop|status` for explicit lifecycle management.

**Startup Sequence:**
```
1. Check lockfile (.eforge/daemon.lock)
2. If lockfile exists AND PID alive AND health check passes → daemon already running, exit
3. Open SQLite DB at .eforge/monitor.db
4. Start HTTP server on port 4567 (with port fallback)
5. Write lockfile { pid, port, startedAt }
6. Start periodic orphan detection loop
7. Disconnect stdio (detach from parent)
8. Listen for SIGTERM/SIGINT → shutdown()
```

**Shutdown:**
```
1. Stop accepting new HTTP connections
2. Close all SSE subscribers
3. Close DB
4. Remove lockfile
5. Exit
```

No countdown, no state machine. Clean and immediate.

### Worker Lifecycle

Workers are eforge CLI processes launched by the daemon to execute builds. They run in the project's cwd with full environment.

**Spawning a worker** (for `POST /api/run`):

```typescript
async function spawnWorker(opts: {
  command: 'run' | 'enqueue' | 'queue-run';
  source?: string;
  flags?: string[];
}): Promise<{ pid: number }> {
  const args = [opts.command];
  if (opts.source) args.push(opts.source);
  args.push('--auto', '--verbose', '--no-monitor');
  if (opts.flags) args.push(...opts.flags);

  const child = spawn('eforge', args, {
    cwd, // daemon's cwd = project root
    detached: true,
    stdio: 'ignore',
    env: { ...process.env },
  });
  child.unref();

  return { pid: child.pid! };
}
```

**Key design**: Workers use `--no-monitor`. This makes `ensureMonitor()` open the DB with `noServer: true` — records events to SQLite but doesn't spawn a server process. The daemon IS the server, workers just record.

**Worker tracking**: The daemon tracks spawned worker PIDs in memory (not persisted — SQLite `runs.pid` column already has this). On cancellation, the daemon sends SIGTERM to the worker PID. The worker's signal handler (already wired in CLI via `setupSignalHandlers()` → AbortController) propagates to the engine.

**Orphan detection**: Unchanged from current monitor. The daemon runs the same periodic loop (`server-main.ts` lines 156-167): check each running run's PID, mark dead ones as 'killed'. Single project, single DB — no generalization needed.

### CLI Independence

The CLI continues to work without the daemon:

```
eforge run prd.md
  → calls ensureMonitor(cwd)
  → checks lockfile (.eforge/daemon.lock or .eforge/monitor.lock)
  → if alive server found: reuses it (same as today)
  → if no server: spawns per-project monitor with auto-shutdown (current behavior)
  → runs engine, records to SQLite, renders to stdout
```

Phase 1: CLI and daemon are independent. Both can run builds. SQLite is the shared coordination point. The daemon discovers CLI-launched builds via its DB polling loop.

### MCP Proxy Project Resolution

Since the daemon is per-project, the MCP proxy needs to find the right daemon for its Claude Code session's working directory. The proxy:

1. Gets cwd from its own process environment (Claude Code spawns the MCP server in the project's working directory)
2. Reads `.eforge/daemon.lock` from that cwd
3. If daemon is running → connects to `http://localhost:<port>`
4. If not running → auto-starts daemon via `fork()` (same pattern as `ensureMonitor()`)

No `project` parameter needed on MCP tool calls — the proxy is inherently scoped to one project.

### New HTTP Endpoints (Control Plane)

Added to `src/monitor/server.ts` alongside existing read endpoints:

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/run` | Launch `eforge run` as worker process, return sessionId |
| `POST` | `/api/enqueue` | Launch `eforge enqueue` as worker, return result |
| `POST` | `/api/cancel/:sessionId` | Send SIGTERM to worker PID |
| `GET` | `/api/config/show` | Return resolved config |
| `GET` | `/api/config/validate` | Validate config |
| `POST` | `/api/queue/run` | Launch queue processing (with optional `--watch`) |

POST endpoints accept JSON body. Workers are spawned with `--no-monitor` (records to SQLite, no server). The daemon polls SQLite for events (existing 200ms poll loop). No `project` parameter needed — daemon is already scoped to one project.

### MCP Tool Surface

Phase 1 tools (all scoped to the project the MCP proxy is connected to):

| Tool | Maps to | Purpose |
|------|---------|---------|
| `eforge_run` | `POST /api/run` | Launch a build, returns sessionId |
| `eforge_enqueue` | `POST /api/enqueue` | Queue a PRD |
| `eforge_status` | `GET /api/run-state` | Build status + plan progress |
| `eforge_queue_list` | `GET /api/queue` | List queued PRDs |
| `eforge_events` | `GET /api/events/:runId` | Event stream for a session |
| `eforge_plans` | `GET /api/plans/:id` | Compiled plan content |
| `eforge_diff` | `GET /api/diff/:sid/:pid` | Post-build diffs |
| `eforge_config` | `GET /api/config/*` | Show/validate config |

Phase 2 additions: `eforge_cancel`, `eforge_queue_run`, `eforge_pause`.

No `project_path` parameter needed on any tool — the proxy is inherently scoped to the project it was spawned in.

### Plugin Skill Migration

Skills evolve from CLI delegators to MCP tool instructors:

- `/eforge:run` → calls `mcp__eforge__eforge_run` instead of `Bash: eforge run --auto --verbose`
- `/eforge:status` → calls `mcp__eforge__eforge_status` instead of `Read: .eforge/state.json`
- `/eforge:enqueue` → calls `mcp__eforge__eforge_enqueue` instead of `Bash: eforge enqueue`
- `/eforge:config` → calls `mcp__eforge__eforge_config` instead of `Bash: eforge config show`

Skills remain as instructional markdown — they validate input, explain output, suggest next steps. The MCP tools do the actual work.

### Session Registry

Extend the existing `runs` table in SQLite (already has `id`, `session_id`, `command`, `status`, `started_at`, `cwd`, `pid`) with:
- `client_info` (optional: which Claude Code session started it)
- Worker PID tracking for cancellation

No new table needed — the existing schema covers the coordination requirements.

### Roadmap Updates

**Before implementation** — add to `docs/roadmap.md`:

```markdown
## Daemon & MCP Server

**Goal**: Evolve the monitor into a persistent per-project daemon with MCP server interface for multi-session coordination and build control.

- **Phase 1 (current)** — Persistent daemon + MCP proxy: make monitor persistent, add control-plane HTTP routes, MCP stdio proxy in plugin, migrate skills from CLI delegation to MCP tools
- **Phase 2** — Control plane: build cancellation, queue auto-build mode, queue priority/reordering, web UI controls
- **Phase 3** — Re-guidance: build interruption with amended context, daemon-to-worker IPC for mid-build guidance changes
```

Insert after "Parallel Execution Reliability" (before "Multimodal Input") since this is higher priority than multimodal.

**After Phase 1 ships** — remove Phase 1 bullet from roadmap, update Phase 2 to "(current)". Shipped work lives in git history and CLAUDE.md, not the roadmap.

## Scope

### In Scope

**Phase 1a — Daemon Infrastructure (no MCP yet):**
1. Refactor `server-main.ts` — persistent mode, remove auto-shutdown state machine
2. Rename lockfile to `.eforge/daemon.lock` (backward compat check for `monitor.lock`)
3. Add control-plane POST routes to `server.ts`
4. Implement worker launcher (spawns `eforge run/enqueue` as detached child with `--no-monitor`)
5. Add `eforge daemon start|stop|status` CLI commands
6. Keep backward compat: CLI users without daemon get current behavior

**Phase 1b — MCP Layer:**
7. Implement MCP stdio proxy using `@modelcontextprotocol/sdk`
8. Define MCP tool schemas and HTTP-to-MCP mapping
9. Add `.mcp.json` to `eforge-plugin/`
10. Migrate plugin skills from CLI delegation to MCP tool calls
11. Bump plugin version

**Phase 1c — Roadmap Update:**
12. Update `docs/roadmap.md` — add Daemon & MCP Server section (Phase 2/3 ahead), mark Phase 1 as shipped by removing it from the roadmap

### Out of Scope (Future Phases)

**Phase 2 — Control Plane:**
- Cancel support (SIGTERM to worker PID via MCP tool + web UI button)
- Queue auto-build mode (long-running worker with `--watch`)
- Queue priority/reordering (MCP tool + web UI drag-reorder)
- Web UI Start/Cancel buttons hitting same POST endpoints

**Phase 3 — Re-guidance:**
- Build interruption: kill worker, re-launch with amended plan + partial work context
- Git worktree isolation helps — partial work is committed, re-guided agent sees the diff
- Approach: "kill and re-run with amended context" rather than checkpoint/resume agent state
- Requires IPC channel from daemon to worker for guidance relay

**Parallel Build Safety (Separate Concern):**
- Static analysis of file lists from plan metadata to determine parallelism safety (green/yellow/red)
- Agent call for ambiguous overlap cases only
- The daemon has the global view of "what's running and what does it touch" — natural home for this logic
- Deferred until after Phase 1 is stable

### What Changes vs. What Stays

**Stays the same:**
- `EforgeEngine` and all engine internals
- `AgentBackend` / `ClaudeSDKBackend`
- `AsyncGenerator<EforgeEvent>` pattern
- `withRecording()` middleware
- `MonitorDB` schema (extended, not replaced)
- Existing GET HTTP routes
- CLI commands (work independently of daemon)
- Worktree-based parallel execution
- `eforge.yaml` config format

**Changes:**
- `src/monitor/server-main.ts`: persistent lifecycle replaces auto-shutdown state machine
- `src/monitor/server.ts`: adds POST control-plane routes + worker spawning
- `src/monitor/lockfile.ts`: rename to `daemon.lock` with backward compat
- `src/monitor/index.ts`: `ensureMonitor()` gains daemon awareness
- `eforge-plugin/`: adds `.mcp.json`, MCP proxy script, updates skills
- `docs/roadmap.md`: add Daemon & MCP Server section with Phase 2/3; remove Phase 1 after shipping

**New:**
- Extension of `src/monitor/`: worker launcher, daemon entry point mode
- `eforge-plugin/mcp/`: stdio proxy script
- `@modelcontextprotocol/sdk` dependency (for proxy only, not engine)

## Acceptance Criteria

### Phase 1a — Daemon Infrastructure

1. `eforge daemon start` (from project root) creates lockfile at `.eforge/daemon.lock` and health endpoint responds on the advertised port
2. `eforge daemon status` shows running daemon info (port, pid, uptime)
3. `eforge daemon stop` cleanly shuts down the daemon, removes lockfile, closes DB and SSE subscribers
4. `POST /api/run` with a simple errand PRD spawns a worker process, events appear in SQLite, and SSE delivers them to connected clients
5. `POST /api/enqueue` queues a PRD via a worker process and returns result
6. `POST /api/cancel/:sessionId` sends SIGTERM to the worker PID and the run is marked as killed
7. `GET /api/config/show` returns the resolved config; `GET /api/config/validate` validates the config
8. `POST /api/queue/run` launches queue processing as a worker
9. Existing CLI workflow (`eforge run prd.md`) still works without daemon running — `ensureMonitor()` falls back to current behavior (spawns per-project monitor with auto-shutdown)
10. With daemon running, CLI-launched builds still record to SQLite and daemon serves their events via SSE
11. Orphan detection works for daemon-spawned workers (dead PIDs marked as killed)
12. Backward compat: daemon checks both `.eforge/daemon.lock` and `.eforge/monitor.lock` during lockfile detection

### Phase 1b — MCP Layer

1. Updated plugin with `.mcp.json` is recognized by Claude Code — MCP server connects successfully
2. MCP proxy auto-starts the daemon if not running (via `fork()` + lockfile pattern)
3. `/eforge:run` calls `mcp__eforge__eforge_run` — build launches, sessionId returned
4. `/eforge:status` calls `mcp__eforge__eforge_status` — current build status returned
5. `/eforge:enqueue` calls `mcp__eforge__eforge_enqueue` — PRD queued successfully
6. `/eforge:config` calls `mcp__eforge__eforge_config` — resolved config returned
7. `eforge_queue_list` returns list of queued PRDs
8. `eforge_events` returns event stream for a given run
9. `eforge_plans` returns compiled plan content
10. `eforge_diff` returns post-build diffs
11. Multiple Claude Code sessions can see each other's builds via the same daemon
12. Kill daemon mid-build — proxy auto-restarts it, worker continues recording to SQLite
13. Plugin version bumped in `eforge-plugin/.claude-plugin/plugin.json`

### Phase 1c — Roadmap Update

1. `docs/roadmap.md` contains Daemon & MCP Server section with Phase 2/3 ahead, inserted after "Parallel Execution Reliability"
2. Phase 1 content is removed from roadmap after shipping (shipped work lives in git history and CLAUDE.md)

### Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| Plugin MCP format uncertainty | Validated: plugins use `.mcp.json` at root, `type: "stdio"` supported. Stripe plugin confirms pattern. |
| Daemon as single point of failure | Proxy auto-restarts daemon. CLI works independently. Daemon is stateless (SQLite is truth). |
| Port conflicts across projects | Port fallback already works (current monitor tries port+1 on EADDRINUSE). Each project gets its own port. |
| Worker process orphaning | Existing orphan detection (`isPidAlive()`) extended to cover workers. |
| Breaking CLI workflow | Daemon is additive. Existing `ensureMonitor()` fallback preserved. |

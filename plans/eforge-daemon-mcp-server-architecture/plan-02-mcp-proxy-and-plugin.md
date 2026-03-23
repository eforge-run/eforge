---
id: plan-02-mcp-proxy-and-plugin
name: MCP Proxy and Plugin Migration
depends_on: [plan-01-daemon-infrastructure]
branch: eforge-daemon-mcp-server-architecture/mcp-proxy-and-plugin
---

# MCP Proxy and Plugin Migration

## Architecture Context

With the daemon running and control-plane routes available (from Plan 01), this plan adds the MCP layer: a stdio proxy that bridges Claude Code's MCP protocol to the daemon's HTTP API, and migrates plugin skills from CLI delegation to MCP tool calls.

The proxy uses `@modelcontextprotocol/sdk` to implement an MCP server over stdio. Claude Code spawns it per-session via the plugin's `.mcp.json`. The proxy auto-starts the daemon if not running (same `fork()` + lockfile pattern as `ensureMonitor()`).

## Implementation

### Overview

1. **Create MCP proxy script** at `eforge-plugin/mcp/eforge-mcp-proxy.js` — a standalone Node.js script (~150 lines) using `@modelcontextprotocol/sdk`. Defines MCP tools that map to daemon HTTP endpoints. Reads `.eforge/daemon.lock` from cwd to find the daemon port. Auto-starts daemon if not running.
2. **Add `.mcp.json`** to `eforge-plugin/` — declares the `eforge` MCP server with `type: "stdio"` pointing to the proxy script.
3. **Migrate plugin skills** — update all 4 skill files to instruct Claude Code to use MCP tools instead of Bash/Read delegation.
4. **Add `@modelcontextprotocol/sdk` dependency** to `package.json`.
5. **Bump plugin version** in `eforge-plugin/.claude-plugin/plugin.json`.

### Key Decisions

1. **Proxy is a plain `.js` file, not TypeScript** — it runs standalone via `node`, not through the tsup bundle. This avoids build pipeline complexity. It's small enough (~150 lines) that TypeScript overhead isn't justified. The SDK is imported from `node_modules` at runtime.
2. **Proxy resolves daemon port from lockfile** — reads `.eforge/daemon.lock` (falling back to `.eforge/monitor.lock`) from `process.cwd()`. Claude Code spawns MCP servers in the project directory, so cwd is correct.
3. **Auto-start uses `spawn('eforge', ['daemon', 'start'])` + lockfile poll** rather than reimplementing the fork logic — reuses the CLI command from Plan 01. Simpler and ensures consistent behavior.
4. **MCP tool schemas use JSON Schema** with clear descriptions — each tool maps 1:1 to an HTTP endpoint. Tools that don't need parameters (like `eforge_status`, `eforge_queue_list`, `eforge_config`) have empty input schemas.
5. **Skills become instructional rather than executable** — they no longer run Bash commands or Read files directly. Instead they instruct Claude Code to call `mcp__eforge__<tool>` and explain the response format and suggested next steps. `disable-model-invocation: true` stays since skills are still deterministic instructions.
6. **SDK dependency goes in `dependencies`** (not devDependencies) — the proxy imports it at runtime. However, it's only used by the proxy script, not the engine. It's added to the root `package.json` since the proxy lives in the plugin directory which shares the same `node_modules`.

## Scope

### In Scope
- MCP proxy script with 8 tool definitions (Phase 1 tools from PRD)
- Daemon auto-start from proxy
- `.mcp.json` in plugin root
- Skill file updates (all 4: run, enqueue, status, config)
- `@modelcontextprotocol/sdk` dependency
- Plugin version bump
- Error handling in proxy (daemon connection failures, HTTP errors → MCP error responses)

### Out of Scope
- `eforge_cancel` tool (Phase 2)
- `eforge_queue_run` tool (Phase 2 — queue auto-build)
- `eforge_pause` tool (Phase 2)
- New skills (e.g., `/eforge:plan` for conversational PRD authoring)
- Proxy tests (integration-level, not unit-testable)

## Files

### Create
- `eforge-plugin/mcp/eforge-mcp-proxy.js` — MCP stdio proxy. Imports `@modelcontextprotocol/sdk/server` and `@modelcontextprotocol/sdk/server/stdio`. Defines tools: `eforge_run` (POST /api/run), `eforge_enqueue` (POST /api/enqueue), `eforge_status` (GET /api/run-state), `eforge_queue_list` (GET /api/queue), `eforge_events` (GET /api/events/:runId with pagination), `eforge_plans` (GET /api/plans/:runId), `eforge_diff` (GET /api/diff/:sessionId/:planId), `eforge_config` (GET /api/config/show + GET /api/config/validate). Each tool wraps an HTTP call to `http://localhost:<port>` where port comes from lockfile. Includes `ensureDaemon()` function that checks lockfile, spawns `eforge daemon start` if needed, polls for readiness.
- `eforge-plugin/.mcp.json` — MCP server declaration: `{ "mcpServers": { "eforge": { "type": "stdio", "command": "node", "args": ["./mcp/eforge-mcp-proxy.js"] } } }`

### Modify
- `eforge-plugin/skills/run/run.md` — Replace Bash delegation (`eforge run ...`) with instruction to call `mcp__eforge__eforge_run` tool with `{ source, flags }`. Update response handling to explain sessionId return value and suggest checking status via `mcp__eforge__eforge_status`. Remove monitor lockfile reading logic (daemon URL is known from MCP context).
- `eforge-plugin/skills/enqueue/enqueue.md` — Replace Bash delegation with `mcp__eforge__eforge_enqueue` tool call instruction. Simplify flow since MCP handles error responses natively.
- `eforge-plugin/skills/status/status.md` — Replace direct Read of `.eforge/state.json` and Glob of queue directory with `mcp__eforge__eforge_status` and `mcp__eforge__eforge_queue_list` tool calls. Remove manual JSON parsing instructions.
- `eforge-plugin/skills/config/config.md` — Replace `Bash: eforge config validate` and `eforge config show` with `mcp__eforge__eforge_config` tool calls (with `action: 'show'` or `action: 'validate'` parameter).
- `eforge-plugin/.claude-plugin/plugin.json` — Bump version (e.g., `0.1.0` → `0.2.0`). Version must increment since MCP server is added and skills are rewritten.
- `package.json` — Add `@modelcontextprotocol/sdk` to `dependencies`.

## Verification

- [ ] `eforge-plugin/.mcp.json` exists and contains valid MCP server declaration with `type: "stdio"`
- [ ] `node eforge-plugin/mcp/eforge-mcp-proxy.js` starts without error when run from the project root (exits cleanly when stdin closes)
- [ ] MCP proxy auto-starts daemon when `.eforge/daemon.lock` does not exist (verified by checking lockfile appears after proxy startup)
- [ ] MCP proxy connects to existing daemon when lockfile exists and health check passes
- [ ] `eforge_run` tool returns `{ sessionId }` when called with `{ source: "test.md" }`
- [ ] `eforge_status` tool returns session status with plan progress
- [ ] `eforge_enqueue` tool queues a PRD and returns confirmation
- [ ] `eforge_queue_list` tool returns array of queued PRDs
- [ ] `eforge_events` tool returns events for a given run ID
- [ ] `eforge_plans` tool returns compiled plan content for a given run ID
- [ ] `eforge_diff` tool returns diffs for a given session/plan
- [ ] `eforge_config` tool returns resolved config (action: 'show') or validation result (action: 'validate')
- [ ] Plugin version in `eforge-plugin/.claude-plugin/plugin.json` is greater than `0.1.0`
- [ ] `@modelcontextprotocol/sdk` is listed in `package.json` `dependencies`
- [ ] Updated skill files reference `mcp__eforge__*` tool names instead of Bash/Read commands
- [ ] Skill files still have `disable-model-invocation: true` frontmatter
- [ ] `pnpm type-check` passes
- [ ] `pnpm build` succeeds

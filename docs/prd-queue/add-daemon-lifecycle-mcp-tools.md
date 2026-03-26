---
title: Add daemon lifecycle MCP tools
created: 2026-03-26
status: pending
---

# Add daemon lifecycle MCP tools

## Problem / Motivation

The `/eforge:restart` skill currently shells out to `eforge daemon stop` and `eforge daemon start`. MCP tools should be the interface for daemon control, not shell commands. Additionally, there is no way to programmatically stop or restart the daemon via MCP.

## Goal

Add an `eforge_daemon` MCP tool with `start`, `stop`, and `restart` actions, and update the restart skill to use this tool instead of shell commands.

## Approach

1. **Add a daemon shutdown API endpoint** to `src/monitor/server.ts` (e.g. `POST /api/daemon/stop`). When called, it should gracefully shut down the daemon process. Accept a `force` boolean parameter.
2. **Add `eforge_daemon` MCP tool** to `src/cli/mcp-proxy.ts` with three actions:
   - **`start`**: Calls `ensureDaemon()` which auto-starts if not running. Returns port and a confirmation.
   - **`stop`**: Checks for active builds via `GET /api/latest-run` + `GET /api/run-summary/{sessionId}`. If builds are running and `force` is not true, return an error telling the caller builds are active. Otherwise, send `POST /api/daemon/stop` to the daemon, then return success.
   - **`restart`**: Stop (with same active build guard + `force` flag) then start. The proxy can call `ensureDaemon()` after stop to auto-start a fresh daemon.
3. **Update `eforge-plugin/skills/restart/restart.md`** to call `mcp__eforge__eforge_daemon` with action `restart` instead of shell commands. Remove the manual build-check step since the MCP tool handles it internally.
4. **Bump plugin version** in `eforge-plugin/.claude-plugin/plugin.json`.

## Scope

**In scope:**
- `src/monitor/server.ts` - add shutdown endpoint
- `src/cli/mcp-proxy.ts` - add `eforge_daemon` tool
- `eforge-plugin/skills/restart/restart.md` - update to use MCP tool
- `eforge-plugin/.claude-plugin/plugin.json` - version bump

**Out of scope:**
- `src/cli/daemon-client.ts` - do NOT modify
- `eforge-plugin/mcp/eforge-mcp-proxy.mjs` (standalone proxy) - do NOT modify

## Acceptance Criteria

- `eforge_daemon` MCP tool with `start`, `stop`, and `restart` actions works correctly.
- `stop` fails with an error message when builds are active, unless `force=true`.
- Restart skill uses the MCP tool instead of shell commands.
- `pnpm type-check` and `pnpm test` pass.

---
id: plan-01-npx-plugin-invocations
name: Use npx for plugin eforge invocations
depends_on: []
branch: use-npx-for-plugin-eforge-invocations/npx-plugin-invocations
---

# Use npx for plugin eforge invocations

## Architecture Context

The eforge plugin uses bare `eforge` in its `.mcp.json` config and MCP proxy daemon spawn. This only works when `eforge` is globally installed or on PATH. Users who run via `npx eforge` (the default install path in the README) get plugin failures because the MCP server and daemon spawn can't find the binary. Switching to `npx -y eforge` makes the plugin work for both developer and regular-user install paths. The `-y` flag prevents interactive install prompts that would hang the MCP server.

Internal spawns in `src/cli/daemon-client.ts` and `src/monitor/server-main.ts` are out of scope - they run inside an already-started eforge process.

## Implementation

### Overview

Replace bare `eforge` with `npx -y eforge` in three plugin files (`.mcp.json`, both MCP proxy scripts), update the update skill to use `npx -y eforge --version` and MCP tools for daemon control, expand the README Development section, and bump the plugin version.

### Key Decisions

1. Use `npx -y eforge` (not `npx eforge`) to auto-confirm install prompts - an MCP server runs headless and cannot prompt the user
2. Update the error message in `ensureDaemon()` to reference `npx -y eforge daemon start` instead of bare `eforge daemon start`
3. The update skill switches daemon stop/start from shell commands to `mcp__eforge__eforge_daemon` MCP tool calls, matching how `/eforge:restart` already works
4. Both `.mjs` and `.js` proxy files must be updated - they are maintained copies (not generated)

## Scope

### In Scope
- `eforge-plugin/.mcp.json` - change command from `eforge` to `npx`, add `-y` and `eforge` to args
- `eforge-plugin/mcp/eforge-mcp-proxy.mjs` - change `spawn('eforge', ...)` to `spawn('npx', ['-y', 'eforge', ...])`; update error message
- `eforge-plugin/mcp/eforge-mcp-proxy.js` - same changes as `.mjs`
- `eforge-plugin/skills/update/update.md` - use `npx -y eforge --version` and MCP tools for daemon control
- `README.md` - expand Development section with npx convention, developer workflow, daemon restart info
- `eforge-plugin/.claude-plugin/plugin.json` - version bump to 0.5.8

### Out of Scope
- Internal spawns in `src/cli/daemon-client.ts` and `src/monitor/server-main.ts`
- Any changes to the engine or CLI code

## Files

### Modify
- `eforge-plugin/.mcp.json` - change `"command": "eforge"` to `"command": "npx"` and `"args": ["mcp-proxy"]` to `"args": ["-y", "eforge", "mcp-proxy"]`
- `eforge-plugin/mcp/eforge-mcp-proxy.mjs` - line 98: change `spawn('eforge', ['daemon', 'start'], ...)` to `spawn('npx', ['-y', 'eforge', 'daemon', 'start'], ...)`; update error message at line 120 to reference `npx -y eforge daemon start`
- `eforge-plugin/mcp/eforge-mcp-proxy.js` - line 94: same spawn change; update error message at line 116 to reference `npx -y eforge daemon start`
- `eforge-plugin/skills/update/update.md` - Step 1: change `eforge --version` to `npx -y eforge --version`; Step 4: change `eforge --version` to `npx -y eforge --version`; Step 5: replace shell `eforge daemon stop`/`eforge daemon start` with `mcp__eforge__eforge_daemon` MCP tool calls using `action: "stop"` then `action: "start"`, and replace the post-restart version check with `npx -y eforge --version`; Step 6: update the post-restart version check to `npx -y eforge --version`; Error table: update `eforge --version` references to `npx -y eforge --version`
- `README.md` - expand the Development section (currently lines 80-86) to document: the `npx -y eforge` convention and why it's used, developer build workflow (`pnpm build` makes `eforge` available on PATH), daemon restart workflow after local changes (`/eforge:restart`), and the `/eforge-daemon-restart` project-local skill for the eforge repo itself
- `eforge-plugin/.claude-plugin/plugin.json` - bump `"version"` from `"0.5.7"` to `"0.5.8"`

## Verification

- [ ] `eforge-plugin/.mcp.json` has `"command": "npx"` and `"args": ["-y", "eforge", "mcp-proxy"]`
- [ ] `eforge-plugin/mcp/eforge-mcp-proxy.mjs` calls `spawn('npx', ['-y', 'eforge', 'daemon', 'start'], ...)` in `ensureDaemon()`
- [ ] `eforge-plugin/mcp/eforge-mcp-proxy.js` calls `spawn('npx', ['-y', 'eforge', 'daemon', 'start'], ...)` in `ensureDaemon()`
- [ ] Both proxy files' error messages reference `npx -y eforge daemon start` (not bare `eforge`)
- [ ] `eforge-plugin/skills/update/update.md` uses `npx -y eforge --version` for version checks
- [ ] `eforge-plugin/skills/update/update.md` uses `mcp__eforge__eforge_daemon` tool for daemon stop/start (not shell commands)
- [ ] `README.md` Development section explains the `npx -y eforge` convention
- [ ] `README.md` Development section documents `pnpm build` developer workflow
- [ ] `README.md` Development section documents `/eforge:restart` for daemon restarts
- [ ] `README.md` Development section mentions `/eforge-daemon-restart` project-local skill
- [ ] `eforge-plugin/.claude-plugin/plugin.json` version is `"0.5.8"`
- [ ] `pnpm type-check` passes (no TypeScript errors introduced)

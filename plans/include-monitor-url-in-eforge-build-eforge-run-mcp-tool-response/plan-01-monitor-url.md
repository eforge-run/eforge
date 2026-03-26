---
id: plan-01-monitor-url
name: Include monitor URL in MCP tool responses
depends_on: []
branch: include-monitor-url-in-eforge-build-eforge-run-mcp-tool-response/monitor-url
---

# Include monitor URL in MCP tool responses

## Architecture Context

The MCP proxy (`eforge-mcp-proxy.mjs`) is a thin layer between Claude Code and the eforge daemon. It uses `ensureDaemon()` to discover/start the daemon and `daemonRequest()` to make HTTP calls. The daemon port IS the monitor port - the monitor dashboard is served by the same HTTP server. Currently `daemonRequest()` calls `ensureDaemon()` internally and returns raw parsed JSON, discarding the port. The port needs to be surfaced to tool handlers so they can inject `monitorUrl` into responses.

## Implementation

### Overview

Modify `daemonRequest()` to return `{ data, port }` instead of raw data. Update all 8 tool handlers to destructure the new shape. Inject `monitorUrl` into `eforge_run` (both normal and queue-mode branches) and `eforge_enqueue` responses. Bump plugin version.

### Key Decisions

1. Return `{ data, port }` from `daemonRequest()` rather than adding a separate function - keeps the change minimal and avoids duplicating the `ensureDaemon()` call pattern.
2. Inject `monitorUrl` only into `eforge_run` and `eforge_enqueue` responses (the tools that kick off work), not status/events/plans/diff/config tools where a monitor URL adds no value.
3. Use `http://localhost:${port}` (not `127.0.0.1`) for the URL - `localhost` is more user-friendly for clicking/copying.

## Scope

### In Scope
- Modifying `daemonRequest()` return value to include port
- Updating all 8 tool handlers to destructure `{ data }` or `{ data, port }`
- Injecting `monitorUrl` into `eforge_run` (normal mode), `eforge_run` (queue mode), and `eforge_enqueue` responses
- Bumping plugin version in `plugin.json`

### Out of Scope
- Changes to the daemon API endpoints
- Changes to any files beyond `eforge-plugin/mcp/eforge-mcp-proxy.mjs` and `eforge-plugin/.claude-plugin/plugin.json`
- Adding monitor URL to status/events/plans/diff/config tool responses

## Files

### Modify
- `eforge-plugin/mcp/eforge-mcp-proxy.mjs` - Change `daemonRequest()` to return `{ data, port }`. Update all 8 tool handler callbacks to destructure the new return shape. For `eforge_run` (both branches) and `eforge_enqueue`, spread `monitorUrl` into the response object.
- `eforge-plugin/.claude-plugin/plugin.json` - Bump version from `0.5.3` to `0.5.4`.

## Verification

- [ ] `daemonRequest()` returns an object with `data` and `port` fields (not raw parsed JSON)
- [ ] All 8 tool handlers (`eforge_run`, `eforge_enqueue`, `eforge_status`, `eforge_queue_list`, `eforge_events`, `eforge_plans`, `eforge_diff`, `eforge_config`) destructure `{ data }` from `daemonRequest()` and serialize `data` (not the wrapper) in their responses
- [ ] `eforge_run` normal-mode response JSON contains `monitorUrl` field with format `http://localhost:{port}`
- [ ] `eforge_run` queue-mode response JSON contains `monitorUrl` field
- [ ] `eforge_enqueue` response JSON contains `monitorUrl` field
- [ ] `eforge_status`, `eforge_queue_list`, `eforge_events`, `eforge_plans`, `eforge_diff`, and `eforge_config` responses do NOT contain `monitorUrl`
- [ ] `pnpm build` succeeds with no errors
- [ ] Plugin version in `eforge-plugin/.claude-plugin/plugin.json` is `0.5.4`

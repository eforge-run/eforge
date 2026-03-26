---
id: plan-01-monitor-url
name: Include Monitor URL in MCP Tool Responses
depends_on: []
branch: include-monitor-url-in-mcp-tool-responses/monitor-url
---

# Include Monitor URL in MCP Tool Responses

## Architecture Context

The eforge MCP proxy (`src/cli/mcp-proxy.ts`) bridges Claude Code tool calls to the eforge daemon's HTTP API via `daemonRequest()` in `src/cli/daemon-client.ts`. The daemon port is dynamic (assigned at startup, written to a lockfile). Currently, `daemonRequest()` returns only the parsed response body, discarding the port. The MCP tool responses for `eforge_build` and `eforge_enqueue` therefore cannot include the monitor dashboard URL.

## Implementation

### Overview

Change `daemonRequest()` to return `{ data, port }` instead of just the parsed body. Update all call sites to destructure accordingly. For `eforge_build` and `eforge_enqueue` tools in the MCP proxy, inject `monitorUrl: "http://localhost:{port}"` into the response JSON. All other tools destructure `{ data }` and return data as before.

### Key Decisions

1. Return an object `{ data, port }` from `daemonRequest()` rather than adding a separate function - this keeps the API surface minimal and avoids redundant `ensureDaemon()` calls.
2. Inject `monitorUrl` only into `eforge_build` and `eforge_enqueue` responses since those are the tools that kick off work the user would want to monitor. Other tools (status, config, queue_list, auto_build) don't need it.

## Scope

### In Scope
- `src/cli/daemon-client.ts` - change return type of `daemonRequest()`
- `src/cli/mcp-proxy.ts` - update all `daemonRequest()` call sites; inject `monitorUrl` for build/enqueue tools
- `src/cli/index.ts` - update the single `daemonRequest()` call site to destructure `{ data }`

### Out of Scope
- `eforge-plugin/mcp/eforge-mcp-proxy.mjs` - standalone proxy, not used by the plugin
- `eforge-plugin/mcp/eforge-mcp-proxy.js` - standalone proxy, not used by the plugin
- Daemon API endpoints - no changes needed

## Files

### Modify
- `src/cli/daemon-client.ts` - Change `daemonRequest()` return type from `Promise<unknown>` to `Promise<{ data: unknown; port: number }>`. Wrap the existing return value in `{ data: <parsed>, port }`.
- `src/cli/mcp-proxy.ts` - Update all 8 `daemonRequest()` call sites to destructure `{ data, port }` or `{ data }`. For `eforge_build` and `eforge_enqueue` tool handlers, spread `monitorUrl: \`http://localhost:${port}\`` into the response object before serializing. For all other tools, destructure `{ data }` and use `data` where `result` was used before.
- `src/cli/index.ts` - Update the single `daemonRequest()` call (~line 258) to destructure `{ data }` and use `data` in the subsequent `sessionId` extraction.

## Verification

- [ ] `pnpm type-check` passes with zero errors
- [ ] `pnpm test` passes with zero failures
- [ ] In `daemon-client.ts`, `daemonRequest()` return type is `Promise<{ data: unknown; port: number }>`
- [ ] In `mcp-proxy.ts`, the `eforge_build` tool handler's JSON response includes a `monitorUrl` field containing `http://localhost:{port}`
- [ ] In `mcp-proxy.ts`, the `eforge_enqueue` tool handler's JSON response includes a `monitorUrl` field containing `http://localhost:{port}`
- [ ] In `mcp-proxy.ts`, the `eforge_auto_build`, `eforge_status`, `eforge_queue_list`, and `eforge_config` tool handlers do NOT include a `monitorUrl` field
- [ ] In `src/cli/index.ts`, the `daemonRequest()` call site destructures `{ data }` and uses `data` for session ID extraction

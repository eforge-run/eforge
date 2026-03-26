---
title: Include Monitor URL in MCP Tool Responses
created: 2026-03-26
status: pending
---



# Include Monitor URL in MCP Tool Responses

## Problem / Motivation

When `/eforge:build` kicks off a build, the MCP tool response doesn't include the monitor dashboard URL, so Claude can't report it to the user. The daemon port is dynamic (not always 4567), so the URL must come from the tool response.

A previous attempt to fix this modified the wrong file (`eforge-plugin/mcp/eforge-mcp-proxy.mjs` - an unused standalone proxy). The actual MCP proxy used by the plugin is `src/cli/mcp-proxy.ts` backed by `src/cli/daemon-client.ts`.

## Goal

Ensure that calling the `eforge_build` or `eforge_enqueue` MCP tools returns a JSON response that includes a `monitorUrl` field with the correct dynamic daemon port.

## Approach

1. In `src/cli/daemon-client.ts`, modify `daemonRequest()` to return `{ data, port }` instead of just the parsed response body.
2. In `src/cli/mcp-proxy.ts`, for the `eforge_build` and `eforge_enqueue` tools, inject `monitorUrl: "http://localhost:{port}"` into the JSON responses.
3. All other tools should destructure `{ data }` and return just the data as before.

## Scope

**In scope:**
- `src/cli/daemon-client.ts`
- `src/cli/mcp-proxy.ts`

**Out of scope:**
- Do NOT modify the standalone `eforge-plugin/mcp/eforge-mcp-proxy.mjs`
- Do not change the daemon API endpoints

## Acceptance Criteria

- Calling the `eforge_build` MCP tool returns a JSON response that includes a `monitorUrl` field with the correct port (e.g., `"http://localhost:{port}"`).
- Calling the `eforge_enqueue` MCP tool returns a JSON response that includes a `monitorUrl` field with the correct port.
- All other MCP tools continue to return their data unchanged (no `monitorUrl` injected).
- The `daemonRequest()` function in `daemon-client.ts` returns `{ data, port }`.

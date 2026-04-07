# @eforge-build/client

Zero-dependency HTTP client for the eforge daemon.

## Consumers

- Root CLI (`src/cli/index.ts`, `src/cli/mcp-proxy.ts`)
- Monitor (`src/monitor/index.ts`, `src/monitor/server-main.ts`, `src/monitor/registry.ts`)
- Pi extension (`pi-package/extensions/eforge/index.ts`)

## What's included

- **Lockfile operations** - read, write, update, remove the daemon lockfile
- **Daemon client** - `ensureDaemon`, `daemonRequest`, `daemonRequestIfRunning`
- **Response types** - TypeScript interfaces for all daemon HTTP endpoints
- **API version** - `DAEMON_API_VERSION` constant for version negotiation

## Rationale

The Pi extension (`pi-package/`) cannot depend on the main `eforge` package because it pulls in heavy engine dependencies (Claude SDK, build pipeline, etc.) that are unnecessary for a thin HTTP client. This zero-dependency package extracts the shared daemon wire protocol - lockfile operations, HTTP client helpers, and response type definitions - so both the MCP proxy and the Pi extension use the same typed client without duplicating code.

## Note

This is an internal contract package. Application consumers should depend on `eforge` (CLI) or `eforge-pi` (Pi extension) rather than taking a direct dependency on `@eforge-build/client`.

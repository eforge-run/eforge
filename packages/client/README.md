# @eforge-build/client

Zero-dependency HTTP client for the eforge daemon.

## Consumers

- Root CLI (`packages/eforge/src/cli/index.ts`, `packages/eforge/src/cli/mcp-proxy.ts`)
- Monitor (`packages/monitor/src/index.ts`, `packages/monitor/src/server-main.ts`, `packages/monitor/src/registry.ts`)
- Pi extension (`packages/pi-eforge/extensions/eforge/index.ts`)

## What's included

- **Lockfile operations** - read, write, update, remove the daemon lockfile
- **Daemon client** - `ensureDaemon`, `daemonRequest`, `daemonRequestIfRunning`
- **Response types** - TypeScript interfaces for all daemon HTTP endpoints
- **API version** - `DAEMON_API_VERSION` constant for version negotiation

## Rationale

The Pi extension (`packages/pi-eforge/`) cannot depend on the main `@eforge-build/eforge` package because it pulls in heavy engine dependencies (Claude SDK, build pipeline, etc.) that are unnecessary for a thin HTTP client. This zero-dependency package extracts the shared daemon wire protocol - lockfile operations, HTTP client helpers, and response type definitions - so both the MCP proxy and the Pi extension use the same typed client without duplicating code.

## Note

This is an internal contract package. Application consumers should depend on `@eforge-build/eforge` (CLI) or `@eforge-build/pi-eforge` (Pi extension) rather than taking a direct dependency on `@eforge-build/client`.

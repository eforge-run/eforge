# @eforge-build/client

Zero-dependency HTTP client for the eforge daemon.

## Consumers

- Root CLI (`src/cli/index.ts`, `src/cli/mcp-proxy.ts`)
- Monitor server (`src/monitor/server-main.ts`)
- Pi extension (`pi-package/extensions/eforge/index.ts`)

## What's included

- **Lockfile operations** - read, write, update, remove the daemon lockfile
- **Daemon client** - `ensureDaemon`, `daemonRequest`, `daemonRequestIfRunning`
- **Response types** - TypeScript interfaces for all daemon HTTP endpoints
- **API version** - `DAEMON_API_VERSION` constant for version negotiation

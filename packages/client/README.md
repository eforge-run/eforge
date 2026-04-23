# @eforge-build/client

Zero-dependency HTTP client for the eforge daemon.

## Consumers

- Root CLI (`packages/eforge/src/cli/index.ts`, `packages/eforge/src/cli/mcp-proxy.ts`)
- Monitor (`packages/monitor/src/index.ts`, `packages/monitor/src/server-main.ts`, `packages/monitor/src/registry.ts`)
- Pi extension (`packages/pi-eforge/extensions/eforge/index.ts`)

## What's included

- **Lockfile operations** - read, write, update, remove the daemon lockfile
- **Daemon client** - `ensureDaemon`, `daemonRequest`, `daemonRequestIfRunning`
- **Route contract** - `API_ROUTES` constant map + `ApiRoute` type + `buildPath(pattern, params)` helper. Single source of truth for every daemon HTTP path; consumers reference these constants (or the typed helpers below) instead of inlining `/api/...` literals
- **Typed per-route helpers** - `api/queue.ts`, `api/backend.ts`, `api/status.ts`, `api/config.ts`, `api/models.ts`, `api/daemon.ts` expose one function per route (`apiEnqueue`, `apiCancel`, `apiHealth`, `apiListBackends`, ...). Each wraps `daemonRequest<ResponseType>` and returns `{ data, port }`. Read-only status calls that must not auto-spawn the daemon have `*IfRunning` variants
- **Session stream** - `subscribeToSession()` helper and `SessionSummary` type for consuming the daemon's `/api/events/{sessionId}` SSE stream with reconnect/backoff, resolving on `session:end`. SSE/EventSource callers use `API_ROUTES.events` + `buildPath()` directly since they do not go through a JSON helper
- **Request/response types** - TypeScript interfaces for every daemon HTTP endpoint, paired per route
- **API version** - `DAEMON_API_VERSION` constant for version negotiation

## Rationale

The Pi extension (`packages/pi-eforge/`) cannot depend on the main `@eforge-build/eforge` package because it pulls in heavy engine dependencies (Claude SDK, build pipeline, etc.) that are unnecessary for a thin HTTP client. This zero-dependency package extracts the shared daemon wire protocol - lockfile operations, HTTP client helpers, and response type definitions - so both the MCP proxy and the Pi extension use the same typed client without duplicating code.

## Stability

- Public exports are stability-promised within a major version.
- Breaking changes bump the major version and are noted in the release.
- `DAEMON_API_VERSION` is bumped independently when the HTTP contract breaks.

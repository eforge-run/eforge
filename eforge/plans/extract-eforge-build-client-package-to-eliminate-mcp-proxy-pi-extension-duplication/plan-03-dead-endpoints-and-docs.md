---
id: plan-03-dead-endpoints-and-docs
name: Remove dead endpoints and update documentation
depends_on: [plan-01-create-client-package]
branch: extract-eforge-build-client-package-to-eliminate-mcp-proxy-pi-extension-duplication/dead-endpoints-and-docs
---

# Remove dead endpoints and update documentation

## Architecture Context

With `@eforge-build/client` created (Plan 1), this plan handles cleanup: removing two dead HTTP endpoints from the daemon server and updating project documentation to reflect the new package structure.

This plan depends only on Plan 1 and is independent of Plan 2 (Pi migration) - they can run in parallel.

## Implementation

### Overview

1. Delete `POST /api/run` handler (lines 753-776 of `src/monitor/server.ts`).
2. Delete `POST /api/queue/run` handler (lines 805-819 of `src/monitor/server.ts`).
3. Update `docs/roadmap.md` with seven new Integration & Maturity items and modify the Monorepo item.
4. Update `AGENTS.md` sync convention and add `@eforge-build/client` convention.
5. Update `docs/architecture.md` Pi Package section and Mermaid diagram.

### Key Decisions

1. **Dead endpoints confirmed zero callers** - grep across the entire codebase for `/api/run` POST usage and `/api/queue/run` shows no callers. The MCP proxy uses `/api/enqueue` (not `/api/run`). The `/api/queue/run` endpoint was superseded by the auto-build watcher.

2. **Roadmap items are concise directional entries** - per the existing `docs/roadmap.md` style (2-3 sentences per item). Not detailed PRDs.

3. **AGENTS.md sync convention scoping** - the existing "Keep eforge-plugin/ and pi-package/ in sync" convention is narrowed to skills, commands, and user-facing behavior only. Daemon client duplication is no longer a concern since both consumers now import from `@eforge-build/client`.

4. **Architecture diagram gains `@eforge-build/client` as an intermediate node** - positioned between Consumers and Engine, with CLI, Monitor, Plugin, and PiPkg pointing to it.

## Scope

### In Scope
- Dead endpoint deletion from `src/monitor/server.ts`
- `docs/roadmap.md` additions (seven items) and Monorepo item modification
- `AGENTS.md` convention updates
- `docs/architecture.md` updates (text and Mermaid diagram)
- `packages/client/README.md` verification (created in Plan 1)

### Out of Scope
- Any changes to the HTTP API surface beyond deleting the two dead endpoints
- Changes to the health endpoint response (follow-up session)
- Monitor UI adoption of client types

## Files

### Modify
- `src/monitor/server.ts` - Delete `POST /api/run` handler (lines 753-776) and `POST /api/queue/run` handler (lines 805-819). Also delete the `// --- Control-plane POST routes (daemon mode) ---` comment on line 752 if it only introduced these dead routes.
- `docs/roadmap.md` - Add seven items under Integration & Maturity; modify the Monorepo bullet
- `AGENTS.md` - Amend sync convention in Conventions section; add `@eforge-build/client` convention
- `docs/architecture.md` - Add sentence to Pi Package section; add `@eforge-build/client` node to Mermaid diagram

## Implementation Details

### Dead endpoint removal

**`POST /api/run` (lines 753-776):**
```typescript
if (req.method === 'POST' && url === '/api/run') {
  // ... 23 lines of handler code ...
  return;
}
```
Delete this entire block. The comment `// --- Control-plane POST routes (daemon mode) ---` on line 752 introduces this block - keep the comment since `/api/enqueue` (line 777) follows and is a valid control-plane route.

**`POST /api/queue/run` (lines 805-819):**
```typescript
if (req.method === 'POST' && url === '/api/queue/run') {
  // ... 14 lines of handler code ...
  return;
}
```
Delete this entire block.

### Roadmap additions

Under **Integration & Maturity**, add after the existing "Monorepo" bullet:

- **Schema library unification on TypeBox** - Standardize on TypeBox across the codebase. TypeBox schemas are JSON Schema natively (no `z.toJSONSchema()` conversion), already in the dep tree for Pi, and align with Pi's tool API. Prerequisite for shared tool registry.
- **Shared tool registry** - Factor tool definitions into `@eforge-build/client` so MCP proxy and Pi extension become thin adapters. Eliminates remaining ~400 lines of cross-package tool-definition duplication. Depends on schema library unification.
- **Typed SSE events in client package** - Extract `EforgeEvent` wire-protocol types from `src/engine/events.ts` into `@eforge-build/client`. Requires decoupling from engine-internal imports.
- **Pi extension SSE event streaming** - Add SSE subscriber to Pi extension for live build progress via Pi `ExtensionAPI` channel.
- **npm scope migration to `@eforge-build`** - Republish `eforge` as `@eforge-build/cli` and `eforge-pi` as `@eforge-build/pi-extension`. Deprecate old names. Requires major version bump.
- **Monitor UI client adoption** - Port `src/monitor/ui/src/lib/api.ts` to import response types from `@eforge-build/client`.
- **TypeScript project references** - Adopt `tsconfig.json` `references` across workspace members for automatic topological ordering.

Modify the existing **Monorepo** bullet to:
> **Monorepo** - Extend pnpm workspaces (currently monitor UI, `@eforge-build/client`, and pi-package) so the engine, eforge-plugin, and marketing site each get their own package with isolated deps and build configs.

### AGENTS.md changes

In the Conventions section, change:
> **Keep `eforge-plugin/` (Claude Code) and `pi-package/` (Pi) in sync.** These are the two consumer-facing integration packages. When adding or changing CLI commands, MCP tools, skills, or user-facing behavior, update *both* packages. Pi extensions are more capable than Claude Code plugins, so `pi-package/` may have additional features - but every capability exposed in one should be exposed in the other when technically feasible. Always check both directories before considering a consumer-facing change complete.

To:
> **Keep `eforge-plugin/` (Claude Code) and `pi-package/` (Pi) in sync.** These are the two consumer-facing integration packages. When adding or changing CLI commands, MCP tools, skills, or user-facing behavior, update *both* packages. Pi extensions are more capable than Claude Code plugins, so `pi-package/` may have additional features - but every capability exposed in one should be exposed in the other when technically feasible. Always check both directories before considering a consumer-facing change complete. Daemon HTTP client code is shared via `@eforge-build/client` - do not inline it.

Add new convention bullet after the existing ones:
> - **Daemon HTTP client and response types live in `@eforge-build/client` (`packages/client/`).** Do not inline lockfile or daemon-request helpers in the CLI, MCP proxy, Pi extension, or anywhere else - import them from the shared package. Bump `DAEMON_API_VERSION` in `packages/client/src/index.ts` when making breaking changes to the HTTP API surface.

### Architecture.md changes

In the **Pi Package** section (line 57), append:
> Both the Pi extension and the Claude Code MCP proxy use `@eforge-build/client` (`packages/client/`) for the daemon HTTP client and response types - a zero-dep TypeScript package that is the canonical source for the daemon wire protocol.

In the Mermaid diagram, add a `Client` subgraph between Consumers and Engine:
```mermaid
subgraph Client ["@eforge-build/client"]
    DaemonClient["Daemon HTTP Client"]
    LockfileOps["Lockfile Ops"]
    ResponseTypes["Response Types"]
end
```

And update edges so CLI, Plugin, and PiPkg point to Client, while Client does not point to Engine (it's the other side of the wire - Engine implements the contract, Client consumes it).

### Roadmap - Daemon version item update

Modify the existing "Daemon version in health endpoint" item to note that it is now unblocked:
> **Daemon version in health endpoint** - Add `version` (from `package.json`) and `apiVersion` (from `DAEMON_API_VERSION` in `@eforge-build/client`) to `/api/health` so the MCP proxy, Pi extension, and external scripts can self-diagnose version skew. No enforcement layer yet - pure observability. Unblocked by `@eforge-build/client` extraction.

## Verification

- [ ] `grep -c "api/run\b" src/monitor/server.ts` matches only route references for `/api/runs` (GET), not `/api/run` (POST)
- [ ] `grep "api/queue/run" src/monitor/server.ts` returns zero matches
- [ ] `pnpm test` passes (no tests reference the deleted endpoints)
- [ ] `pnpm build` succeeds
- [ ] `docs/roadmap.md` contains "Schema library unification on TypeBox" bullet
- [ ] `docs/roadmap.md` contains "Shared tool registry" bullet
- [ ] `docs/roadmap.md` Monorepo bullet mentions `@eforge-build/client` and `pi-package`
- [ ] `docs/roadmap.md` daemon version item mentions `DAEMON_API_VERSION`
- [ ] `AGENTS.md` contains `@eforge-build/client` convention
- [ ] `AGENTS.md` sync convention includes "do not inline" language
- [ ] `docs/architecture.md` Pi Package section mentions `@eforge-build/client`
- [ ] `docs/architecture.md` Mermaid diagram includes `@eforge-build/client` node

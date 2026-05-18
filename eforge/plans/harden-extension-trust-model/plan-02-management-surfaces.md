---
id: plan-02-management-surfaces
name: Daemon, Client, CLI, MCP, and Pi Trust Management
branch: harden-extension-trust-model/plan-02-management-surfaces
agents:
  builder:
    effort: high
    rationale: This plan coordinates a new mutation route across shared client
      types, daemon routing, CLI rendering, and two agent integration surfaces.
  reviewer:
    effort: high
    rationale: Management routes change the trust boundary and must be reviewed for
      path validation, cross-origin protection, and no execution during trust.
---

# Daemon, Client, CLI, MCP, and Pi Trust Management

## Architecture Context

Plan 01 adds engine helpers that can discover, hash, and trust/untrust committed project/team extension candidates without importing extension code. This plan exposes those helpers through the daemon API, shared client package, CLI, MCP proxy, and Pi extension while keeping the Claude Code and Pi surfaces in sync.

Mutation routes must follow the existing extension management protection pattern in `packages/monitor/src/server.ts`: local-machine origin checks, loopback Host checks, and no cross-origin browser mutation.

## Implementation

### Overview

Add explicit trust and untrust management operations and expose trust/hash/provenance in all list/show/validate/test/reload response shapes and human-readable CLI output.

### Key Decisions

1. `eforge extension trust <nameOrPath>` and `untrust <nameOrPath>` update trust records only. They must discover and hash candidates but must not call `loadNativeExtensions` or import extension code.
2. Trust by name only targets project/team candidates. If zero or multiple project/team candidates match, return a 404 or 409 with a specific error. Trust by path must resolve to a project/team extension under `eforge/extensions/`; reject user, project-local, external, and path-escaping inputs.
3. Trust/untrust responses return the updated candidate/trust metadata and a message with next steps. Loading is left to an explicit `validate`, `test`, `reload`, or later build operation.
4. The API adds routes and optional response fields. Because this adds routes/optional fields rather than removing or renaming existing fields, do not bump `DAEMON_API_VERSION` unless implementation changes an existing required field or route semantics in a breaking way.

## Scope

### In Scope

- Shared client route constants and helpers for trust/untrust.
- Shared client wire types for trust metadata, current hash, trusted hash, trust identity, trust record, and trust/untrust requests/responses.
- Daemon POST routes for trust and untrust using engine trust-store helpers without executing extension code.
- Route path validation and cross-origin protections matching `extensionNew`, `extensionReload`, and `extensionTest` mutation routes.
- CLI commands:
  - `eforge extension trust <nameOrPath> [--json]`
  - `eforge extension untrust <nameOrPath> [--json]`
- Human-readable `eforge extension list` table with a trust column and short hash/change indicators.
- Human-readable `eforge extension show` detail with trust state, current hash, trusted hash, trust timestamp/source, and trust diagnostics.
- MCP proxy `eforge_extension` actions `trust` and `untrust` with action-specific parameter validation.
- Pi `eforge_extension` tool actions `trust` and `untrust` with validation parity to MCP.
- Tests for routes, client helpers, CLI rendering/commands, MCP/Pi parity, and no execution during trust.

### Out of Scope

- Documentation content updates and plugin skill text updates. Those are handled by plan 03.
- Package installation or manifest conventions.
- Interactive daemon prompts.

## Files

### Modify

- `packages/client/src/routes.ts` — add `extensionTrust` and `extensionUntrust` route constants.
- `packages/client/src/types.ts` — extend `ExtensionTrust`, `ExtensionEntry`, diagnostics/provenance fields, and add trust/untrust request/response types.
- `packages/client/src/api/extensions.ts` — export `apiTrustExtension` and `apiUntrustExtension` using route constants only.
- `packages/monitor/src/server.ts` — add trust/untrust POST routes, body validation, candidate resolution, trust-store mutation, and non-executing response projection.
- `packages/eforge/src/cli/index.ts` — add trust/untrust subcommands and render trust/hash/provenance in list/show output.
- `packages/eforge/src/cli/mcp-proxy.ts` — extend `eforge_extension` action enum, description, parameter validation, and handler branches.
- `packages/pi-eforge/extensions/eforge/index.ts` — mirror MCP `eforge_extension` action enum, description, validation messages, and handler branches. Do not bump `packages/pi-eforge/package.json`.
- `test/extension-tooling-routes.test.ts` — cover trust/untrust routes, client helpers, path/name validation, cross-origin rejection, and no extension import during trust.
- `test/extension-cli-commands.test.ts` — cover CLI command registration, non-JSON trust/hash rendering, JSON trust/untrust responses, and changed-state rendering.
- `test/extension-tooling-wiring.test.ts` — add route constants/helper assertions and MCP/Pi action parity assertions.

## Verification

- [ ] `API_ROUTES` contains `/api/extensions/trust` and `/api/extensions/untrust`, and client helpers reference those constants without literal `/api/extensions/` strings.
- [ ] POST trust with `{ name: "team" }` writes a local trust record for an untrusted project/team extension and returns current hash metadata without executing the extension factory.
- [ ] POST untrust removes the matching trust record and returns the candidate as untrusted without executing the extension factory.
- [ ] POST trust rejects project-local, user, external, path-escaping, unknown, and ambiguous targets with 400, 404, or 409 responses.
- [ ] Trust/untrust mutation routes reject cross-origin callers and non-loopback Host headers.
- [ ] `eforge extension list` includes a trust column and short hash/change indicators in non-JSON output.
- [ ] `eforge extension show <name>` prints trust state, current hash, trusted hash when present, and trust timestamp/source when present.
- [ ] `eforge extension trust <nameOrPath> --json` and `untrust --json` print the typed daemon response.
- [ ] MCP and Pi `eforge_extension` action enums include `trust` and `untrust`, and both surfaces reject unsupported parameter combinations with matching messages.
---
id: plan-02-daemon-client-cli-extension-visibility
name: Daemon, Client, and CLI Extension Visibility
branch: add-extension-discovery-config-and-loader/plan-02-daemon-client-cli-extension-visibility
agents:
  builder:
    effort: high
    rationale: Adds a new daemon API surface and CLI commands that must preserve
      route-contract discipline and wire-type consistency.
  reviewer:
    effort: high
    rationale: Review must check HTTP route validation, wire shapes, CLI exit
      semantics, and absence of inline /api literals outside API_ROUTES.
---

# Daemon, Client, and CLI Extension Visibility

## Architecture Context

The client package owns daemon route constants and response types; the monitor daemon dispatches via `API_ROUTES`; the CLI must use the shared client helpers instead of duplicating daemon request logic. This plan exposes the engine registry from plan-01 through daemon/client/CLI tooling so extension provenance and diagnostics are visible without adding full manager commands.

## Implementation

### Overview

Add typed list/show/validate routes for native extensions, implement daemon handlers that load the engine extension registry for the current repo, and add a minimal `eforge extension` CLI command group. The surfaces must return structured data with name, scope, path, source kind, status, shadows, diagnostics, and registration summaries.

### Key Decisions

1. Use singular route names mirroring existing artifact routes: `/api/extension/list`, `/api/extension/show`, and `/api/extension/validate`.
2. Keep wire types in `@eforge-build/client` and map engine registry entries into those types at the daemon boundary.
3. `validate` returns `valid: false` and CLI exit code `1` when one or more loaded/resolved entries have `status: "error"`; `untrusted`, `excluded`, and `disabled` entries remain visible but do not by themselves make the registry invalid.
4. `show` takes a `name` query parameter and returns the highest-precedence non-shadow entry with that name; ambiguous explicit duplicates are represented in diagnostics and validation output.

## Scope

### In Scope

- Route constants and typed helpers in `@eforge-build/client`.
- Daemon handlers for extension list/show/validate.
- CLI command group `eforge extension list`, `eforge extension show <name>`, and `eforge extension validate [name]`.
- Deterministic rendering for CLI list and diagnostics.
- API and CLI tests for statuses, shadows, registration summaries, and non-zero validation behavior.

### Out of Scope

- New/edit/promote/demote/reload/trust commands.
- Monitor UI pages for extensions.
- MCP/Pi tools and slash skills; plan-03 adds integration parity.

## Files

### Create

- `packages/client/src/api/extension.ts` — Typed daemon helper functions for extension list/show/validate.
- `packages/eforge/src/cli/extension.ts` — Commander registration for the `eforge extension` command group and CLI render helpers if kept local.
- `test/native-extension-api.test.ts` — In-process daemon route tests for list/show/validate responses.
- `test/cli-extension-command.test.ts` — CLI command registration and validate-exit behavior tests using the existing Commander test style.

### Modify

- `packages/client/src/routes.ts` — Add `extensionList`, `extensionShow`, and `extensionValidate` route constants.
- `packages/client/src/types.ts` — Add extension wire types: scope, source kind, status, diagnostic, shadow, registration summary, list entry, and response shapes.
- `packages/client/src/index.ts` — Export extension API helpers and wire types.
- `packages/client/src/browser.ts` — Export browser-safe extension wire types and route constants.
- `packages/monitor/src/server.ts` — Add handlers for the new routes using `API_ROUTES`, load resolved config and registry helpers from the engine, and return client-owned response shapes.
- `packages/eforge/src/cli/index.ts` — Register the new extension command module.
- `packages/eforge/src/cli/display.ts` — Add shared list/diagnostic rendering if not kept inside `extension.ts`.

## Verification

- [ ] `API_ROUTES.extensionList`, `API_ROUTES.extensionShow`, and `API_ROUTES.extensionValidate` exist and no new hard-coded `/api/extension...` literals appear outside route tests or generated docs.
- [ ] `apiExtensionList()`, `apiExtensionShow()`, and `apiExtensionValidate()` call `daemonRequest` with the new route constants.
- [ ] `GET /api/extension/list` returns an `extensions` array and `valid` boolean for a repo with no extension files.
- [ ] `GET /api/extension/list` returns a project-local winner with a project-team shadow when both scopes contain the same extension name.
- [ ] `GET /api/extension/show?name=<name>` returns `404` for a missing name and returns one matching entry for an existing name.
- [ ] `GET /api/extension/validate` returns `valid: false` and at least one diagnostic when an extension default export is not a function.
- [ ] `eforge extension list` prints one deterministic row per entry containing name, scope, source, status, and path.
- [ ] `eforge extension validate` exits with code `1` when the daemon validation response has `valid: false`.
- [ ] `eforge extension validate <name>` filters printed diagnostics to entries matching that name while preserving the response `valid` value for that target.
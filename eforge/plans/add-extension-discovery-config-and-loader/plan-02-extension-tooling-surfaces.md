---
id: plan-02-extension-tooling-surfaces
name: Extension Tooling Surfaces
branch: add-extension-discovery-config-and-loader/plan-02-extension-tooling-surfaces
agents:
  builder:
    effort: high
    rationale: Cross-package client, daemon, CLI, MCP, and Pi wiring must preserve
      route-contract discipline and consumer parity.
  reviewer:
    effort: high
    rationale: New daemon endpoints expose executable extension diagnostics and need
      API/security review.
---

# Extension Tooling Surfaces

## Architecture Context

The engine foundation produces extension registry/provenance data. This plan exposes that data through the shared daemon route contract, CLI commands, and matching MCP/Pi tool surfaces without duplicating `/api/...` literals. Client response shapes own the daemon wire protocol; monitor handlers and consumers must import those types and route constants.

## Implementation

### Overview

Add extension list/show/validate response types and API helpers in `@eforge-build/client`, implement daemon routes in `packages/monitor`, add `eforge extension list/show/validate` CLI commands, and expose a matching `eforge_extension` tool in both the Claude Code MCP proxy and the Pi extension. The validate command returns a non-zero exit code or `valid: false` when extension load errors exist.

### Key Decisions

1. Add route constants under `API_ROUTES` instead of inline path strings: `extensionList`, `extensionShow`, and `extensionValidate`.
2. Use daemon wire types from `packages/client/src/types.ts`; do not redeclare response shapes in monitor or integration packages.
3. Implement list/show/validate as read-only operations. They do not mutate config, trust state, extension files, or daemon state.
4. Keep trust prompts, enable/disable, reload, promote/demote, scaffold, and event replay test commands out of this slice.
5. Add one parity MCP/Pi tool named `eforge_extension` with `action: 'list' | 'show' | 'validate'`, optional `name`, and optional ad-hoc `path` for validation.
6. Do not add a new Claude/Pi slash skill in this plan. `/eforge:extend` remains a later scaffold workflow.

## Scope

### In Scope

- Client-owned wire types for extension diagnostics, statuses, shadows, registration summaries, list entries, and list/show/validate responses.
- Typed client API helper functions for list/show/validate.
- Daemon route handlers that call engine extension projection helpers and return JSON.
- CLI `eforge extension list`, `eforge extension show <name>`, and `eforge extension validate [nameOrPath]` commands with JSON output support.
- MCP proxy `eforge_extension` tool.
- Pi extension `eforge_extension` tool using the same daemon routes and response semantics.
- Tests for route constants/helpers, daemon route responses, CLI command registration, and MCP/Pi tool wiring.

### Out of Scope

- Monitor UI pages for extensions.
- Extension manager mutations: trust, enable, disable, reload, promote, demote, scaffold, delete, install, and replay-test.
- New plugin or Pi slash skills.
- Daemon API version bump unless an existing route or response is changed incompatibly.

## Files

### Create

- `packages/client/src/api/extensions.ts` — Typed client helper functions for `apiListExtensions`, `apiShowExtension`, and `apiValidateExtensions`.
- `test/extension-tooling-routes.test.ts` — In-process daemon route tests for extension list/show/validate with temp extension files.
- `test/extension-tooling-wiring.test.ts` — Static wiring tests for CLI command registration and MCP/Pi `eforge_extension` tool parity.

### Modify

- `packages/client/src/routes.ts` — Add extension route constants and any request interfaces that belong beside route declarations.
- `packages/client/src/types.ts` — Add client-owned wire types: scope, source, status, diagnostic, shadow, registration summary, extension entry, list/show/validate responses.
- `packages/client/src/index.ts` — Export extension API helpers and response types.
- `packages/client/src/browser.ts` — Export browser-safe extension response types and route constants.
- `packages/monitor/src/server.ts` — Add GET handlers for extension list/show/validate using `API_ROUTES` and engine projection helpers; reject unsafe query paths with existing path validation patterns.
- `packages/eforge/src/cli/index.ts` — Add `extension` command group with `list`, `show`, and `validate`; format table output plus `--json`; exit 1 on validate responses with `valid: false`.
- `packages/eforge/src/cli/mcp-proxy.ts` — Add `eforge_extension` tool that dispatches through client route constants/helpers.
- `packages/pi-eforge/extensions/eforge/index.ts` — Add matching `eforge_extension` native Pi tool with the same action/name/path parameters.
- `packages/pi-eforge/extensions/eforge/config-command.ts` — Include the resolved `extensions` config block in the native `/eforge:config` overlay if present.

## Verification

- [ ] `API_ROUTES.extensionList`, `API_ROUTES.extensionShow`, and `API_ROUTES.extensionValidate` exist and match the daemon handlers.
- [ ] Client helper tests prove route helpers call the shared constants and return the client-owned response types.
- [ ] `GET extensionList` returns loaded, excluded, untrusted, and error entries with name, scope, path, source, status, shadows, registration summary, and diagnostics.
- [ ] `GET extensionShow?name=<name>` returns the requested extension entry and returns 404 for an unknown name.
- [ ] `GET extensionValidate` returns `valid: false` when any extension entry has status `error` and includes the diagnostic messages.
- [ ] CLI command registration includes `eforge extension list`, `eforge extension show <name>`, and `eforge extension validate [nameOrPath]`.
- [ ] `eforge extension validate` exits with code 1 for a temp extension with an invalid default export.
- [ ] MCP proxy source registers `eforge_extension` and references only `API_ROUTES.extension*` or exported client helpers for daemon calls.
- [ ] Pi extension source registers `eforge_extension` and references only `API_ROUTES.extension*` or exported client helpers for daemon calls.
- [ ] `pnpm --filter @eforge-build/client type-check` passes.
- [ ] `pnpm test -- test/extension-tooling-routes.test.ts test/extension-tooling-wiring.test.ts` passes.
---
id: plan-01-extension-management-api
name: Extension Management API, Scaffold Helper, and Reload Runtime
branch: extend-04-extension-management-surface-mvp/plan-01-extension-management-api
agents:
  builder:
    effort: high
    rationale: Coordinates wire contracts, filesystem-safe scaffold writes, daemon
      route behavior, and watcher reload lifecycle without stopping build
      workers.
  reviewer:
    effort: high
    rationale: Path-safety, API contract, and watcher lifecycle semantics need
      careful review.
---

# Extension Management API, Scaffold Helper, and Reload Runtime

## Architecture Context

The existing extension management surface already covers `list`, `show`, and `validate` through `@eforge-build/client`, daemon routes, and projection from the native extension loader. EXTEND_04 adds the missing foundation for `new` and `reload` while preserving the current route/helper pattern: route paths live in `API_ROUTES`, consumers call typed `@eforge-build/client` helpers, and filesystem scope resolution uses `@eforge-build/scopes` instead of hand-built paths.

Reload must refresh management discovery and, when the persistent daemon watcher is active, restart that in-process watcher so future events use a fresh native extension registry. Stopping the watcher must not cancel in-flight PRD child workers.

## Implementation

### Overview

Add the client wire contract, reusable scaffold helper, daemon routes, explicit derived enablement state, watcher reload callback, and API-focused tests. This plan does not wire CLI/MCP/Pi commands; those consume these helpers in plan 02.

### Key Decisions

1. Use user-facing `new` in routes and helpers (`extensionNew`, `apiNewExtension`) and use `scaffoldNativeExtension` as the internal engine helper name.
2. Add `enabled?: boolean` to `ExtensionEntry` for backward-compatible TypeScript consumption; the daemon must populate it for every returned entry. Derive it as `false` when global extensions are disabled, for `excluded` and `shadowed` entries, and for entries skipped solely by include/exclude config filters. Derive it as `true` for entries selected by current config, including `loaded`, `error`, and trust-related `skipped` entries. Trust and status remain the source of why a selected entry did or did not load.
3. Support `local | project | user` in the request, mapped to `project-local | project-team | user` for scope resolution.
4. Default scaffold template is `event-logger`; add `blank` as the second supported template. The default template must import from `@eforge-build/extension-sdk` and register an `onEvent` handler.
5. Implement explicit `force` overwrite support. Without `force`, an existing target file returns a conflict response.
6. Reload returns fresh extension response data plus watcher metadata. When no watcher is active, reload still refreshes management discovery and reports that no runtime watcher was restarted.

## Scope

### In Scope

- Add `extensionNew` and `extensionReload` route constants and typed client helpers.
- Add request/response types for scaffold/new and reload.
- Add optional `enabled` to extension list/show entries and populate it in daemon responses.
- Create a reusable scaffold helper under `packages/engine/src/extensions/`.
- Add POST daemon routes for new/scaffold and reload.
- Add a daemon-state callback in `server-main.ts` that restarts the active watcher without touching PRD child worker processes.
- Add API/helper/scaffold tests.

### Out of Scope

- CLI command registration and rendering for `extension new` / `extension reload`.
- MCP proxy and Pi tool action updates.
- Event replay testing or `extension test`.
- Per-extension enable/disable state, promote/demote, or trust prompt storage.

## Files

### Create

- `packages/engine/src/extensions/scaffold.ts` — Scope mapping, name/template validation, template rendering, safe file writes, and result metadata for extension scaffolding.
- `test/extension-scaffold.test.ts` — Direct helper tests for scope paths, template content, invalid names, unknown templates, overwrite conflict, and `force` overwrite.

### Modify

- `packages/client/src/routes.ts` — Add `API_ROUTES.extensionNew` and `API_ROUTES.extensionReload`.
- `packages/client/src/types.ts` — Add extension scaffold/reload request and response types, template/scope aliases, watcher reload metadata, and `ExtensionEntry.enabled?: boolean`.
- `packages/client/src/api/extensions.ts` — Add `apiNewExtension()` and `apiReloadExtensions()` using `API_ROUTES` constants and POST requests.
- `packages/client/src/index.ts` — Re-export new helpers and public types.
- `packages/client/src/browser.ts` — Re-export new public types for browser consumers.
- `packages/engine/src/extensions/index.ts` — Re-export the scaffold helper, supported template list, and helper types/errors.
- `packages/monitor/src/server.ts` — Populate `enabled`, add POST `/api/extensions/new`, add POST `/api/extensions/reload`, map scaffold errors to 400/409 responses, and preserve path-safe ad-hoc validation behavior.
- `packages/monitor/src/server-main.ts` — Extend `DaemonState` with `onReloadExtensions` and implement watcher restart metadata using existing `stopWatcher()` / `startWatcher()` functions.
- `test/extension-tooling-routes.test.ts` — Add daemon/client tests for new/reload routes and enabled field values.
- `test/extension-tooling-wiring.test.ts` — Extend route/helper static checks for the two new route constants and helpers.

## Implementation Notes

- Scaffold name validation must reject path separators, NUL bytes, `.` and `..` segments, empty names, and names that resolve outside the target `extensions/` directory.
- Use `getConfigDir(cwd) ?? getConventionalConfigDir(cwd)` before calling `getScopeDirectory()`.
- The helper must create `<scopeDir>/extensions/` and write `<name>.ts`.
- Use `writeFile(..., { flag: 'wx' })` or equivalent conflict detection when `force` is false.
- Return a supported-template list in unknown-template error messages.
- Reload route response shape must include fresh `extensions`, `diagnostics`, and `totals`, plus watcher fields such as `wasRunning`, `restarted`, `running`, `previousSessionId`, `sessionId`, and a human-facing message.
- Watcher reload must not call worker cancellation functions or send kill signals to PRD child worker PIDs.

## Verification

- [ ] `API_ROUTES.extensionNew` equals `/api/extensions/new` and `API_ROUTES.extensionReload` equals `/api/extensions/reload`.
- [ ] `packages/client/src/api/extensions.ts` uses `API_ROUTES.extensionNew` and `API_ROUTES.extensionReload` and contains no literal `'/api/extensions/` or `"/api/extensions/` strings.
- [ ] List/show entries include `enabled` for every extension; global-disabled or include/exclude-filtered entries report `enabled: false`, while selected loaded/error/trust-skipped entries report `enabled: true` with status/trust diagnostics unchanged.
- [ ] `POST /api/extensions/new` with `{ "name": "audit" }` creates `.eforge/extensions/audit.ts` containing `defineEforgeExtension` and `onEvent`.
- [ ] `POST /api/extensions/new` with an existing target and no `force` returns HTTP 409 and leaves the existing file content unchanged.
- [ ] `POST /api/extensions/new` rejects `../audit`, `..`, empty names, and unknown templates with HTTP 400.
- [ ] `POST /api/extensions/reload` returns extension list data and watcher metadata.
- [ ] A reload with an active watcher reports `wasRunning: true` and `restarted: true`; a reload without an active watcher reports `wasRunning: false` and `restarted: false`.
- [ ] Existing ad-hoc validation traversal rejection in `GET /api/extensions/validate?path=../outside.js` still returns HTTP 400.
- [ ] `pnpm vitest run test/extension-scaffold.test.ts test/extension-tooling-routes.test.ts test/extension-tooling-wiring.test.ts` passes.

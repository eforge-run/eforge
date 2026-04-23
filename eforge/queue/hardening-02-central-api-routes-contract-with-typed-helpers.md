---
title: "Hardening 02: central API_ROUTES contract with typed helpers"
scope: excursion
depends_on: [2026-04-22-hardening-01-shared-types-and-constants]
---

## Problem / Motivation

Daemon HTTP paths are hardcoded string literals in at least eight files outside the daemon itself:

- `packages/eforge/src/cli/index.ts`
- `packages/eforge/src/cli/mcp-proxy.ts`
- `packages/pi-eforge/extensions/eforge/index.ts`
- `packages/engine/src/review-heuristics.ts`
- `packages/monitor-ui/src/lib/api.ts`
- `packages/monitor-ui/src/components/layout/{queue-section,shutdown-banner,sidebar}.tsx`
- `test/backend-profile-wiring.test.ts`

The daemon routes live in `packages/monitor/src/server.ts` (~31 handlers between lines 756-1366). Typos in any consumer surface only at runtime. Renaming a route requires manually sweeping ~10 files. Request/response shapes are also redeclared inline rather than referenced from a shared definition.

Additionally, `packages/eforge/src/cli/mcp-proxy.ts:14` imports `sanitizeProfileName` and `parseRawConfigLegacy` from `@eforge-build/engine/config`, coupling the MCP proxy to the engine package. These functions are already re-exported from `@eforge-build/client` - the import site just needs to be updated.

## Goal

`@eforge-build/client` owns an `API_ROUTES` map and typed per-route helpers that return typed responses. Every consumer - CLI, MCP proxy, Pi extension, monitor UI, engine - goes through the helpers. The proxy no longer imports from engine.

## Approach

### 1. Harvest every route from the daemon

Enumerate each `server.route()`/`server.get()`/`server.post()` in `packages/monitor/src/server.ts`. Produce a complete list of `(method, path, params, body, response)` tuples. Confirm you have them all - the list is ~31. Note: `packages/monitor/src/server-main.ts` is a daemon lifecycle manager and contains no route definitions; all routes remain in `server.ts`.

### 2. Define `API_ROUTES` and types in client

In a new `packages/client/src/routes.ts`:

```ts
export const API_ROUTES = {
  enqueue: '/api/enqueue',
  queueList: '/api/queue/list',
  status: '/api/status',
  backendList: '/api/backend/list',
  // ... one entry per daemon route
} as const;

export type ApiRoute = typeof API_ROUTES[keyof typeof API_ROUTES];
```

Next to each route, declare the request and response types (using shared types from PRD 01 where applicable). Prefer one exported type pair per route: `EnqueueRequest` / `EnqueueResponse`, etc.

### 3. Typed helpers

Expose thin helpers on top of `daemonRequest()` so consumers don't pass route strings directly:

```ts
export async function apiEnqueue(opts: { cwd: string; body: EnqueueRequest }): Promise<EnqueueResponse> {
  return daemonRequest<EnqueueResponse>({
    cwd: opts.cwd,
    method: 'POST',
    path: API_ROUTES.enqueue,
    body: opts.body,
  });
}
```

One helper per route. Group related helpers in a single file per concern (`packages/client/src/api/{queue,backend,status,config,models,daemon}.ts`) and re-export from `packages/client/src/index.ts`.

### 4. Migrate consumers

- `packages/eforge/src/cli/mcp-proxy.ts`: replace hand-rolled `daemonRequest({ path: '/api/...' })` calls with the typed helpers.
- `packages/eforge/src/cli/index.ts`: same.
- `packages/pi-eforge/extensions/eforge/index.ts`: same.
- `packages/engine/src/review-heuristics.ts`: same.
- `packages/monitor-ui/src/lib/api.ts`: expose the same helpers to the UI. The UI runs in the browser, so `daemonRequest` is replaced by `fetch` against the same-origin monitor server - the helpers can accept an optional transport argument or the UI can wrap `API_ROUTES` directly. Pick the simpler approach consistent with existing UI patterns.
- `packages/monitor-ui/src/components/layout/{queue-section,shutdown-banner,sidebar}.tsx`: stop hardcoding paths; call helpers from `lib/api.ts`.
- `test/backend-profile-wiring.test.ts`: use `API_ROUTES` constants.

### 5. Remove engine imports from mcp-proxy

`sanitizeProfileName` and `parseRawConfigLegacy` are **already re-exported from `@eforge-build/client`**. No new re-exports are needed. Simply update `packages/eforge/src/cli/mcp-proxy.ts:14` to import from `@eforge-build/client` instead of `@eforge-build/engine/config`.

### 6. Add an eslint rule or a pre-commit check (optional, nice-to-have)

A lint rule that flags string literals matching `'/api/'` outside `packages/client/src/routes.ts` and `packages/monitor/src/server.ts`. Prevents regression. If eslint wiring is heavy, skip - the audit grep in verification is enough for now.

### Files touched

- `packages/client/src/{routes,api/*,index,types}.ts` (new + edited)
- `packages/monitor/src/server.ts` (import the constants rather than inlining strings; optional but recommended for single-source symmetry)
- `packages/eforge/src/cli/{index,mcp-proxy}.ts`
- `packages/pi-eforge/extensions/eforge/index.ts`
- `packages/engine/src/review-heuristics.ts`
- `packages/monitor-ui/src/lib/api.ts`, `components/layout/*.tsx`
- `test/backend-profile-wiring.test.ts`

## Scope

### In scope

- Harvesting and enumerating all ~31 daemon routes from `packages/monitor/src/server.ts`.
- Creating `packages/client/src/routes.ts` with `API_ROUTES` map, `ApiRoute` type, and per-route request/response types.
- Adding typed helpers grouped under `packages/client/src/api/{queue,backend,status,config,models,daemon}.ts` and re-exporting from `packages/client/src/index.ts`.
- Migrating all listed consumers (CLI, MCP proxy, Pi extension, engine review-heuristics, monitor UI lib + layout components, tests) to use the helpers.
- Updating `packages/eforge/src/cli/mcp-proxy.ts` to import `sanitizeProfileName` and `parseRawConfigLegacy` from `@eforge-build/client` instead of `@eforge-build/engine/config` (the re-exports already exist in client).
- Optionally: importing the constants in `packages/monitor/src/server.ts` for single-source symmetry.
- Optionally: an eslint rule or pre-commit check flagging `'/api/'` string literals outside the routes file and daemon server.

### Out of scope

- Daemon version negotiation (PRD 03).
- MCP tool factory refactor (PRD 07) - that PRD will build on the helpers introduced here.
- New routes or route renames.

## Acceptance Criteria

- `pnpm type-check && pnpm build` succeed across the workspace.
- `pnpm test` passes.
- `rg "'/api/" packages/{eforge,pi-eforge,engine,monitor-ui}/src` returns only references from `lib/api.ts` (if helpers live there) and the routes file. No `/api/...` literals in components or tools.
- End-to-end smoke: `eforge daemon start`, `eforge queue list`, `eforge status`, enqueue a trivial PRD, and tail events all succeed.
- `rg "@eforge-build/engine/config" packages/eforge` returns zero hits.
- `API_ROUTES` map in `packages/client/src/routes.ts` contains one entry per daemon route (~31 total), with accompanying request/response types.
- One typed helper per route exists under `packages/client/src/api/{queue,backend,status,config,models,daemon}.ts` and is re-exported from `packages/client/src/index.ts`.
- All listed consumers (`packages/eforge/src/cli/index.ts`, `packages/eforge/src/cli/mcp-proxy.ts`, `packages/pi-eforge/extensions/eforge/index.ts`, `packages/engine/src/review-heuristics.ts`, `packages/monitor-ui/src/lib/api.ts`, `packages/monitor-ui/src/components/layout/{queue-section,shutdown-banner,sidebar}.tsx`, `test/backend-profile-wiring.test.ts`) route through the helpers or `API_ROUTES` constants.
- `packages/eforge/src/cli/mcp-proxy.ts` imports `sanitizeProfileName` and `parseRawConfigLegacy` from `@eforge-build/client`, not `@eforge-build/engine/config`.
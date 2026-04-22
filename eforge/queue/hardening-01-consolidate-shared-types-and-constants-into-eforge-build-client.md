---
title: Hardening 01: Consolidate shared types and constants into `@eforge-build/client`
created: 2026-04-22
---

# Hardening 01: Consolidate shared types and constants into `@eforge-build/client`

## Problem / Motivation

Several types and constants that cross the daemon HTTP boundary are declared independently in multiple packages instead of flowing from a single owner:

- `ReviewProfileConfig` is declared in `packages/engine/src/config.ts`, `packages/client/src/types.ts`, `packages/monitor/src/server.ts`, and `packages/monitor-ui/src/lib/types.ts`. The engine definition has an `autoAcceptBelow` field that the other declarations are missing, so the field is silently dropped when the API serializes it.
- `BuildStageSpec` is declared independently in `packages/client/src/types.ts`, `packages/monitor/src/server.ts`, and `packages/monitor-ui/src/lib/types.ts`.
- `LOCKFILE_POLL_INTERVAL_MS` / `LOCKFILE_POLL_TIMEOUT_MS` are duplicated verbatim in `packages/eforge/src/cli/mcp-proxy.ts:541-542` and `packages/pi-eforge/extensions/eforge/index.ts:44-45`.
- The `EforgeEvent` → `DaemonStreamEvent` serialization relationship (via `packages/client/src/event-to-progress.ts`) is undocumented, so contributors have to infer the mapping.

Any field added to one declaration must be manually added to the others, and drift has already happened.

## Goal

One owner per shared contract. The client package owns types/constants that cross the HTTP boundary. Monitor, monitor-ui, and engine import from it instead of redeclaring.

## Approach

### 1. Promote `ReviewProfileConfig` and `BuildStageSpec` in `@eforge-build/client`

In `packages/client/src/types.ts`, define the complete `ReviewProfileConfig` including `autoAcceptBelow` (copy the engine definition verbatim — `packages/engine/src/config.ts:76-82`). Export `BuildStageSpec` as `string | string[]` (it already exists there; confirm it matches the engine definition at `packages/engine/src/config.ts` and the schema in `packages/engine/src/schemas.ts`).

Re-export both from `packages/client/src/index.ts` alongside existing exports.

### 2. Delete duplicate declarations

- `packages/monitor/src/server.ts` (around lines 298, 304-310): delete the local `BuildStageSpec` and `ReviewProfileConfig` definitions. Import from `@eforge-build/client`.
- `packages/monitor-ui/src/lib/types.ts`: delete the local declarations. Import from `@eforge-build/client`.
- `packages/engine/src/config.ts`: import `ReviewProfileConfig` and `BuildStageSpec` from `@eforge-build/client` and re-export so engine-internal call sites don't change. Keep `zod` schemas in `packages/engine/src/schemas.ts` as the validator source — the Zod schemas can reference the shared type via `z.ZodType<ReviewProfileConfig>` to keep them in sync.

### 3. Move lockfile polling constants to client

In `packages/client/src/lockfile.ts`, export:

```ts
export const LOCKFILE_POLL_INTERVAL_MS = 250;
export const LOCKFILE_POLL_TIMEOUT_MS = 5000;
```

Re-export from `packages/client/src/index.ts`. Update `packages/eforge/src/cli/mcp-proxy.ts:541-542` and `packages/pi-eforge/extensions/eforge/index.ts:44-45` to import instead of redeclaring.

### 4. Document the event serialization mapping

Add a file-header JSDoc block to `packages/client/src/event-to-progress.ts` stating:

> This module maps engine-emitted `EforgeEvent`s (defined in `@eforge-build/engine/events`) onto the wire-format `DaemonStreamEvent` (defined in this package) that consumers receive over `/api/events/:session` SSE. The engine event is the source of truth; `DaemonStreamEvent` is its serialized form. When engine events grow a new field, update the mapper and `DaemonStreamEvent` together.

Add a short `// Serialized form of EforgeEvent — keep in sync with event-to-progress.ts` banner at the top of the `DaemonStreamEvent` declaration in `packages/client/src/session-stream.ts` (or wherever it lives).

### 5. Confirm the `autoAcceptBelow` end-to-end

After consolidation, trace `autoAcceptBelow` from the engine config through the daemon response through the monitor UI build-config panel. If the UI needs to display or set it, wire it through (likely a small addition to `packages/monitor-ui/src/components/plans/build-config.tsx`). If not, leave the rendering alone — the important outcome is that the field is preserved through serialization.

### Files touched

- `packages/client/src/{types,index,lockfile,event-to-progress,session-stream}.ts`
- `packages/engine/src/{config,events}.ts` (imports + possibly re-exports; do not redefine)
- `packages/monitor/src/server.ts`
- `packages/monitor-ui/src/lib/types.ts`, possibly `components/plans/build-config.tsx`
- `packages/eforge/src/cli/mcp-proxy.ts`
- `packages/pi-eforge/extensions/eforge/index.ts`

## Scope

### In scope

- Promoting `ReviewProfileConfig` (including `autoAcceptBelow`) and `BuildStageSpec` to `@eforge-build/client` as the single owner.
- Deleting duplicate declarations in `packages/monitor/src/server.ts`, `packages/monitor-ui/src/lib/types.ts`, and `packages/engine/src/config.ts` (engine re-exports from client).
- Keeping Zod schemas in `packages/engine/src/schemas.ts` as the validator source, referencing the shared type via `z.ZodType<ReviewProfileConfig>`.
- Moving `LOCKFILE_POLL_INTERVAL_MS` and `LOCKFILE_POLL_TIMEOUT_MS` into `packages/client/src/lockfile.ts` and updating `packages/eforge/src/cli/mcp-proxy.ts` and `packages/pi-eforge/extensions/eforge/index.ts` to import them.
- Documenting the `EforgeEvent` → `DaemonStreamEvent` mapping with a JSDoc header on `event-to-progress.ts` and a keep-in-sync banner on the `DaemonStreamEvent` declaration.
- Confirming `autoAcceptBelow` survives serialization end-to-end; wiring it into `packages/monitor-ui/src/components/plans/build-config.tsx` only if the UI needs to display or set it.

### Out of scope

- Changing the actual schema of these types (renames, new fields). This PRD is a pure consolidation.
- Narrowing the `@eforge-build/client` public surface (covered by PRD 12).
- Adding `API_ROUTES` or typed request helpers (covered by PRD 02).

## Acceptance Criteria

- `pnpm type-check` and `pnpm build` pass across the workspace.
- `rg "interface ReviewProfileConfig"` and `rg "interface BuildStageSpec|type BuildStageSpec"` each return exactly one hit (in `packages/client/src/types.ts`).
- `rg "LOCKFILE_POLL_(INTERVAL|TIMEOUT)_MS = "` returns exactly one hit (in `packages/client/src/lockfile.ts`).
- Manual: enqueue a build with `autoAcceptBelow` set in `eforge/config.yaml` and confirm the daemon response for `/api/status` or `/api/config` contains the field.
- `ReviewProfileConfig` in `packages/client/src/types.ts` includes `autoAcceptBelow` (copied verbatim from the engine definition at `packages/engine/src/config.ts:76-82`).
- `BuildStageSpec` is exported from `packages/client/src/types.ts` as `string | string[]` and matches the engine definition and the schema in `packages/engine/src/schemas.ts`.
- Both types are re-exported from `packages/client/src/index.ts`.
- `packages/monitor/src/server.ts` (around lines 298, 304-310), `packages/monitor-ui/src/lib/types.ts`, and `packages/engine/src/config.ts` import `ReviewProfileConfig` and `BuildStageSpec` from `@eforge-build/client`; the engine re-exports them so engine-internal call sites do not change.
- `packages/client/src/event-to-progress.ts` has a file-header JSDoc block describing the `EforgeEvent` → `DaemonStreamEvent` mapping as specified.
- The `DaemonStreamEvent` declaration (in `packages/client/src/session-stream.ts` or wherever it lives) has a `// Serialized form of EforgeEvent — keep in sync with event-to-progress.ts` banner.

---
title: Fix `eforge_init` fresh-project bootstrap ordering bug
created: 2026-04-29
---

# Fix `eforge_init` fresh-project bootstrap ordering bug

## Problem / Motivation

`eforge_init` is documented as the entry point for initializing eforge in a project that has no `eforge/` config yet. In its current form it only succeeds on already-initialized projects; on a fresh checkout the daemon returns `404: No eforge config directory found` and the tool aborts before writing anything.

Root cause is an ordering bug in the fresh-init branch:

- `packages/eforge/src/cli/mcp-proxy.ts` (lines ~687–763): the handler calls `daemonRequest(... API_ROUTES.profileCreate ...)` and `profileUse` **before** running `mkdir`/`writeFile` for `eforge/config.yaml`.
- The daemon's profileCreate handler (`packages/monitor/src/server.ts:1197`) calls `getConfigDir(options?.cwd)`, which delegates to `findConfigFile` (`packages/engine/src/config.ts:493`). `findConfigFile` walks the directory tree looking specifically for the `eforge/config.yaml` *file* - pre-creating just the directory does not help. With no file yet on disk, the lookup returns `null`, and the daemon responds with 404.

The same ordering exists in the Pi consumer at `packages/pi-eforge/extensions/eforge/index.ts:1189–1209`. AGENTS.md requires the two consumer-facing surfaces to stay in sync.

The migrate branch (mcp-proxy.ts:613–685) is unaffected - migration is only valid against an existing legacy `config.yaml`, so the daemon's lookup already succeeds.

The fix needs a small refinement beyond the bug report's "just reorder" suggestion: when `force: true` is passed against an existing `config.yaml`, the current code leaves the file untouched until the very end, so a failed `profileCreate` preserves the user's content. A naive reorder would overwrite that content unconditionally before the daemon call. The fix below preserves that property by only writing a sentinel when the file is missing, and cleaning it up on profileCreate failure.

## Goal

Make `eforge_init` succeed on a fresh checkout (no existing `eforge/` directory) by ensuring `eforge/config.yaml` exists on disk before any daemon profile request, while preserving the existing `force: true` content-protection behavior on failure.

## Approach

Reorder the fresh-init path in both consumers so the config file exists on disk before any daemon profile request. Use a two-write pattern: write an empty sentinel only when needed (so `getConfigDir` resolves), then write the final content at the end.

### Files to modify

- `packages/eforge/src/cli/mcp-proxy.ts` - fresh-init branch (~lines 687–763) inside the `eforge_init` handler.
- `packages/pi-eforge/extensions/eforge/index.ts` - fresh-init branch (~lines 1117–1209) inside the `eforge_init` tool.

### Behavior change (fresh-init branch only)

For both files, restructure the fresh-init flow as:

1. Probe `configPath` existence; throw `McpUserError("... already exists. Use force: true ...")` if it exists and `!force`. (unchanged)
2. **New:** if the file does not exist, `mkdir(configDir, { recursive: true })` and `writeFile(configPath, '', 'utf-8')`. Track this with a local `wroteSentinel` flag.
3. Call `daemonRequest(... API_ROUTES.profileCreate ...)` and `profileUse` inside a `try`. On failure, if `wroteSentinel` is true, `unlink` the sentinel before rethrowing - leave no empty config behind on a failed init.
4. Build `configContent` from `postMergeCommands` and `writeFile(configPath, configContent, 'utf-8')` (final write, supersedes the sentinel; also handles the `force: true` overwrite case).
5. Best-effort `configValidate` call and response shaping (unchanged).

Notes:

- The two-write pattern is intentional. The first write is a daemon-discovery sentinel; the second carries the real content. Don't try to merge them - sequencing is the whole point.
- Do not change anything in the migrate branch.
- Do not modify the daemon's profileCreate handler or `findConfigFile`. The "give the daemon an explicit configDir param" alternative from the bug report is a larger surface change and not needed for this fix.
- `ensureGitignoreEntries(toolCwd, [...])` at the top of the handler can stay where it is; it doesn't depend on the daemon.
- Imports: `mcp-proxy.ts` already has `mkdir`/`writeFile`/`access` from `node:fs/promises`. Add `unlink` to that import. The Pi extension uses sync FS (`mkdirSync`, `writeFileSync`, `accessSync`) - add `unlinkSync` to its `node:fs` imports.

### Existing utilities reused

- `daemonRequest` from `@eforge-build/client` (already imported in both files).
- `API_ROUTES.profileCreate`, `API_ROUTES.profileUse`, `API_ROUTES.configValidate` (already imported).
- `stringifyYaml`, `mkdir`/`writeFile` (mcp-proxy) and `mkdirSync`/`writeFileSync` (Pi extension) - already imported.
- `McpUserError` (mcp-proxy) - already used.

### Regression test

Add one assertion to `test/profile-wiring.test.ts` (in the existing `/eforge:init redesign` describe block) that statically inspects the fresh-init source slice and verifies that `writeFile(configPath` (or `writeFileSync(configPath` for the Pi block) appears **before** `API_ROUTES.profileCreate` in that slice. This is consistent with the file's existing source-grep style and pins the ordering against future regressions.

Skip an integration test - the project's testing conventions (AGENTS.md) explicitly mark daemon orchestration as integration-level and out of scope for the unit suite.

## Scope

### In scope

- Reordering the fresh-init branch in `packages/eforge/src/cli/mcp-proxy.ts` (~lines 687–763).
- Reordering the fresh-init branch in `packages/pi-eforge/extensions/eforge/index.ts` (~lines 1117–1209, 1189–1209).
- Adding `unlink` to `node:fs/promises` imports in `mcp-proxy.ts`, and `unlinkSync` to `node:fs` imports in the Pi extension.
- Two-write sentinel pattern with cleanup on `profileCreate` failure (`wroteSentinel` flag).
- One static source-grep ordering assertion in `test/profile-wiring.test.ts` under the existing `/eforge:init redesign` describe block.

### Out of scope

- Daemon API changes (e.g. accepting an explicit `configDir`/`cwd` in profileCreate).
- Modifying the daemon's profileCreate handler or `findConfigFile`.
- Changes to the migrate branch (mcp-proxy.ts:613–685).
- Plugin version bump - no files in `eforge-plugin/` are modified.
- CHANGELOG edits - release flow owns CHANGELOG.
- Integration tests for daemon orchestration.

## Acceptance Criteria

1. `pnpm type-check` passes for both packages.
2. `pnpm test` passes, including the existing `profile-wiring.test.ts` suite plus the new ordering assertion that verifies `writeFile(configPath` / `writeFileSync(configPath` appears before `API_ROUTES.profileCreate` in the fresh-init source slice for both consumers.
3. `pnpm build` produces the bundled CLI.
4. End-to-end repro of the original failure succeeds:
   - After restarting the daemon (via the `eforge-daemon-restart` skill, which gates on active builds) so the new `mcp-proxy` build is loaded.
   - In a scratch directory with no `eforge/` directory, invoking the MCP tool:
     ```
     mcp__eforge_init({
       profile: {
         name: "x",
         agentRuntimes: { main: { harness: "claude-sdk" } },
         defaultAgentRuntime: "main",
         models: { max: { id: "claude-opus-4-7" }, balanced: { id: "claude-opus-4-7" }, fast: { id: "claude-opus-4-7" } }
       },
       postMergeCommands: []
     })
     ```
   - Returns `status: "initialized"`, with `eforge/config.yaml` and `eforge/profiles/x.yaml` both on disk.
5. Re-running without `force: true` throws "already exists" (idempotency preserved).
6. `force: true` path: editing `eforge/config.yaml` to garbage and re-running with `force: true` rewrites the file cleanly and regenerates the profile.
7. Failure-cleanup path: re-running on a fresh dir with deliberately invalid input (e.g. a profile with `harness: "bogus"`) leaves no empty `eforge/config.yaml` behind after the daemon returns 400.

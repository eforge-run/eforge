---
id: plan-01-fix-fresh-init-ordering
name: Fix eforge_init fresh-init ordering across both consumers
branch: fix-eforge-init-fresh-project-bootstrap-ordering-bug/fix-fresh-init-ordering
---

# Fix eforge_init fresh-init ordering across both consumers

## Architecture Context

`eforge_init` is the entry point for initializing eforge in a fresh project. It is exposed in two consumer-facing surfaces that must stay in sync per AGENTS.md:

- `packages/eforge/src/cli/mcp-proxy.ts` - Claude Code MCP proxy (async `fs/promises`).
- `packages/pi-eforge/extensions/eforge/index.ts` - Pi extension (sync `node:fs`).

Both surfaces talk to the eforge daemon via `daemonRequest` from `@eforge-build/client` and POST to `API_ROUTES.profileCreate` / `API_ROUTES.profileUse`. The daemon's `profileCreate` handler (`packages/monitor/src/server.ts:1197`) calls `getConfigDir(options?.cwd)`, which delegates to `findConfigFile` (`packages/engine/src/config.ts:493`). `findConfigFile` walks the directory tree looking for the `eforge/config.yaml` *file*; an empty directory does not satisfy the lookup. With no file on disk, the daemon returns 404 and the tool aborts.

The migrate branch (mcp-proxy.ts:613-685) is unaffected - it only runs against an existing legacy `config.yaml`, so the daemon's lookup already succeeds.

The daemon API surface is intentionally not changed in this plan: an alternative "give the daemon an explicit configDir param" approach would be a larger surface change and is out of scope.

## Implementation

### Overview

Reorder the fresh-init branch in both consumer files so `eforge/config.yaml` exists on disk before any daemon profile request. Use a two-write sentinel pattern:

1. If the file does not yet exist, `mkdir(configDir, { recursive: true })` then write an empty sentinel file at `configPath`. Track this with a local `wroteSentinel` boolean.
2. Wrap the daemon `profileCreate` + `profileUse` calls in a `try`. If they throw and `wroteSentinel === true`, `unlink` the sentinel before rethrowing - leaves no empty config behind on a failed init.
3. After the daemon calls succeed, build the final `configContent` from `postMergeCommands` and write it to `configPath` (final write supersedes the sentinel; this also handles the `force: true` overwrite case).
4. The best-effort `configValidate` call and response shaping at the end are unchanged.

The two writes are intentional. The first is a daemon-discovery sentinel; the second carries the real content. They cannot be merged - sequencing is the whole point.

The migrate branch (mcp-proxy.ts:613-685 and the analogous block in the Pi extension) is not touched.

### Key Decisions

1. **Two-write sentinel pattern, not a single pre-write of final content.** Pre-writing the final `configContent` would clobber a user's existing `config.yaml` on the `force: true` path before the daemon call has been validated to succeed. The empty sentinel is only written when the file does not exist (`wroteSentinel` only true in that case), so the existing `force: true` content-protection behavior on daemon failure is preserved.
2. **Explicit cleanup on daemon failure.** When `wroteSentinel === true` and `profileCreate`/`profileUse` throws, `unlink(configPath)` runs before rethrowing. Acceptance criterion 7 requires no empty `eforge/config.yaml` left behind on a failed init in a fresh dir.
3. **Do not change the daemon or `findConfigFile`.** The bug report's alternative ("give the daemon an explicit configDir param") is a larger surface change. The PRD explicitly scopes that out.
4. **Imports.** `mcp-proxy.ts` already imports `mkdir`, `writeFile`, `access` from `node:fs/promises`; add `unlink` to that import. The Pi extension already imports `mkdirSync`, `writeFileSync`, `accessSync` from `node:fs`; add `unlinkSync` to that import.
5. **Regression test is a static source-grep.** Per the existing style of `test/profile-wiring.test.ts`, assert that `writeFile(configPath` (or `writeFileSync(configPath`) appears before `API_ROUTES.profileCreate` in the fresh-init source slice for both consumers. Daemon orchestration is integration-level and out of scope for the unit suite (AGENTS.md).

## Scope

### In Scope

- Reorder the fresh-init branch in `packages/eforge/src/cli/mcp-proxy.ts` (~lines 687-763) to write the config file before calling `profileCreate`.
- Reorder the fresh-init branch in `packages/pi-eforge/extensions/eforge/index.ts` (~lines 1117-1209) to write the config file before calling `profileCreate`.
- Add `unlink` to the `node:fs/promises` import in `mcp-proxy.ts`.
- Add `unlinkSync` to the `node:fs` import in the Pi extension.
- Implement the `wroteSentinel` flag + cleanup-on-failure path in both files.
- Add one ordering-assertion test pair to `test/profile-wiring.test.ts` under the existing `/eforge:init redesign (plan-02-consumers)` describe block.

### Out of Scope

- Daemon API changes (e.g. accepting an explicit `configDir`/`cwd` in `profileCreate`).
- Modifying the daemon's `profileCreate` handler or `findConfigFile`.
- Changes to the migrate branch in either consumer.
- Plugin version bump - no files in `eforge-plugin/` are modified.
- CHANGELOG edits - the release flow owns CHANGELOG (per user feedback).
- Integration tests for daemon orchestration (AGENTS.md scopes those out of the unit suite).

## Files

### Modify

- `packages/eforge/src/cli/mcp-proxy.ts` - Reorder the fresh-init branch (~lines 687-763) inside the `eforge_init` handler:
  - Add `unlink` to the existing `import { mkdir, writeFile, access } from 'node:fs/promises'` at the top of the file.
  - Keep the existing `access(configPath)` / `!force` precondition check that throws `McpUserError("... already exists. Use force: true ...")`.
  - Resolve `resolvedSpec`, `profileName`, `agentsBlock`, and `createBody` (these computations stay where they are; they do not depend on the daemon).
  - Introduce `let wroteSentinel = false;`. If `configPath` does not exist on disk, `await mkdir(configDir, { recursive: true })` and `await writeFile(configPath, '', 'utf-8')`, then set `wroteSentinel = true`. Use the same existence probe shape already in the handler (try `access`, treat ENOENT as "missing").
  - Wrap `await daemonRequest(... API_ROUTES.profileCreate ...)` and `await daemonRequest(... API_ROUTES.profileUse ...)` in `try { ... } catch (err) { if (wroteSentinel) { try { await unlink(configPath); } catch {} } throw err; }`.
  - After the daemon calls succeed, build `configContent` from `postMergeCommands` (existing logic) and `await writeFile(configPath, configContent, 'utf-8')`. Drop the now-redundant `try { await mkdir(configDir, { recursive: true }); } catch {}` wrapper around the directory creation - the sentinel branch already created the directory, and on the `force: true` path the directory necessarily already exists (the file existence check guaranteed it).
  - Leave the best-effort `configValidate` call and the `status: "initialized"` response shaping unchanged.

- `packages/pi-eforge/extensions/eforge/index.ts` - Apply the same reorder to the fresh-init branch (~lines 1117-1209) inside the `eforge_init` tool:
  - Add `unlinkSync` to the existing `node:fs` import (alongside `mkdirSync`, `writeFileSync`, `accessSync`).
  - Keep the existing `accessSync(configPath)` / `!params.force` precondition that throws `"eforge/config.yaml already exists. Use force: true ..."`.
  - Resolve `resolvedSpec`, runtime validation loop, `profileName`, `agentsBlock`, `createBody` (unchanged).
  - Introduce `let wroteSentinel = false;`. If `configPath` does not exist on disk, `mkdirSync(configDir, { recursive: true })` and `writeFileSync(configPath, '', 'utf-8')`, then set `wroteSentinel = true`. Reuse the existing ENOENT-tolerant `accessSync` probe shape.
  - Wrap the two `daemonRequest` calls (`API_ROUTES.profileCreate`, then `API_ROUTES.profileUse`) in `try { ... } catch (err) { if (wroteSentinel) { try { unlinkSync(configPath); } catch {} } throw err; }`.
  - After the daemon calls succeed, build `configContent` (existing logic) and `writeFileSync(configPath, configContent, "utf-8")`. Drop the now-redundant `try { mkdirSync(configDir, { recursive: true }); } catch {}` wrapper for the same reason as above.
  - Leave the best-effort `configValidate` call and response shaping unchanged.

- `test/profile-wiring.test.ts` - Inside the existing `describe('/eforge:init redesign (plan-02-consumers)', ...)` block (around line 705), add two new ordering-assertion tests using the existing `getMcpInitBlock()` and `getPiInitBlock()` helpers and the `Fresh init mode` / equivalent slice marker:
  - `it('MCP proxy eforge_init writes config file before calling profileCreate in the fresh-init branch', () => { ... })` - takes `getMcpInitBlock()`, slices from `Fresh init mode` to end, asserts that the index of `writeFile(configPath` is greater than -1, the index of `API_ROUTES.profileCreate` is greater than -1, and `slice.indexOf('writeFile(configPath') < slice.indexOf('API_ROUTES.profileCreate')`.
  - `it('Pi extension eforge_init writes config file before calling profileCreate in the fresh-init branch', () => { ... })` - same shape against `getPiInitBlock()`, but using `writeFileSync(configPath` and the Pi block's `Fresh init mode` marker.
  - These mirror the `expect(source).toContain(...)` / index-comparison style already used in the file (e.g. lines 256, 313).

## Verification

- [ ] `pnpm type-check` exits 0 with no errors in either `packages/eforge` or `packages/pi-eforge`.
- [ ] `pnpm test` exits 0, including the existing `test/profile-wiring.test.ts` suite plus both new ordering-assertion tests.
- [ ] In `test/profile-wiring.test.ts`, the new MCP-proxy assertion verifies `writeFile(configPath` appears before `API_ROUTES.profileCreate` in the fresh-init source slice.
- [ ] In `test/profile-wiring.test.ts`, the new Pi-extension assertion verifies `writeFileSync(configPath` appears before `API_ROUTES.profileCreate` in the fresh-init source slice.
- [ ] `pnpm build` exits 0 and produces `packages/eforge/dist/cli.js`.
- [ ] In a scratch directory with no `eforge/` directory, calling `mcp__eforge_init({ profile: { name: "x", agentRuntimes: { main: { harness: "claude-sdk" } }, defaultAgentRuntime: "main", models: { max: { id: "claude-opus-4-7" }, balanced: { id: "claude-opus-4-7" }, fast: { id: "claude-opus-4-7" } } }, postMergeCommands: [] })` returns `status: "initialized"` and produces both `eforge/config.yaml` and `eforge/profiles/x.yaml` on disk.
- [ ] Re-running the same call in the same directory without `force: true` throws an `McpUserError` whose message contains `already exists`.
- [ ] After overwriting `eforge/config.yaml` with garbage content (e.g. `not: [valid: yaml`), re-running with `force: true` rewrites the file with the regenerated content and the profile is still present.
- [ ] In a fresh scratch directory, calling `mcp__eforge_init` with a deliberately invalid runtime (`agentRuntimes: { main: { harness: "bogus" } }`) results in the daemon returning 400 and `eforge/config.yaml` does NOT exist on disk afterwards (the sentinel was unlinked).
- [ ] The migrate branch is byte-identical to its prior state (verified via `git diff` showing zero changes between mcp-proxy.ts:613-685 and the equivalent migrate block in the Pi extension).
- [ ] No files under `eforge-plugin/` are modified by this plan.
- [ ] `CHANGELOG.md` is not modified by this plan.
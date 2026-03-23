---
id: plan-02-cli-mcp-plugin
name: CLI Rename, MCP Proxy, Plugin Overhaul
depends_on: [plan-01-daemon-infrastructure]
branch: plan-queue-first-eforge-run/cli-mcp-plugin
---

# CLI Rename, MCP Proxy, Plugin Overhaul

## Architecture Context

With daemon infrastructure in place (plan-01), this plan updates all consumer surfaces: the CLI command renames `run` → `build` with daemon-first default path, the MCP proxy aligns tool names and behavior, and plugin skills are overhauled to match.

## Implementation

### Overview

1. **CLI**: Rename `run` command to `build`, add `run` as hidden alias, add `--foreground` flag, default path enqueues via daemon and exits
2. **MCP proxy**: Rename `eforge_run` → `eforge_build` (enqueue-only via daemon), add `eforge_auto_build` tool
3. **Plugin**: Remove `/eforge:run` and `/eforge:enqueue` skills, create `/eforge:build`, bump version

### Key Decisions

1. **`run` stays as hidden alias** — backwards compatibility. Same action handler, just an alias.
2. **Default path is daemon delegation** — `eforge build <source>` calls `ensureDaemon`, `POST /api/enqueue`, prints status, exits. No in-process execution unless `--foreground` or daemon unreachable.
3. **Fallback on daemon failure** — if `ensureDaemon` throws, warn and fall through to existing in-process `allPhases()` path. This becomes the `--foreground` code path.
4. **`eforge_build` MCP tool is enqueue-only** — calls `POST /api/enqueue`, returns `{ sessionId, autoBuild }`. No `--queue`/`--watch` flags. The daemon watcher handles queue processing.
5. **`eforge_auto_build` MCP tool** — get/set auto-build state via `GET/POST /api/auto-build`.
6. **Plugin version bump to 0.5.0** — reflects the command surface change.

## Scope

### In Scope
- Rename `run` command to `build` in Commander setup
- Add `run` as hidden backwards-compatible alias
- Add `--foreground` flag to `build` command
- New default path: `ensureDaemon` → `POST /api/enqueue` → print status → exit
- Fallback to in-process execution when daemon is unreachable
- `--foreground` flag forces in-process execution (existing `allPhases()` code)
- `--queue`, `--watch`, `--dry-run` flags retain existing behavior (in-process)
- MCP proxy: rename `eforge_run` → `eforge_build`, make it enqueue-only
- MCP proxy: remove queue mode from `eforge_build`
- MCP proxy: new `eforge_auto_build` tool
- Plugin: delete `eforge-plugin/skills/run/run.md`
- Plugin: delete `eforge-plugin/skills/enqueue/enqueue.md`
- Plugin: create `eforge-plugin/skills/build/build.md`
- Plugin: update `plugin.json` commands array and bump version

### Out of Scope
- Changes to existing `--queue` / `--queue --watch` behavior
- Changes to the engine pipeline
- Documentation updates (plan-03)

## Files

### Create
- `eforge-plugin/skills/build/build.md` — New `/eforge:build` skill. Accepts a source (file path or inline text), calls `mcp__eforge__eforge_build`, reports "PRD enqueued, daemon will auto-build" with sessionId and monitor URL. Includes error handling for file not found and daemon unreachable.

### Modify
- `src/cli/index.ts` — Rename `.command('run [source]')` to `.command('build [source]')`. Add `.alias('run')` for backwards compatibility. Add `.option('--foreground', 'Run in-process instead of delegating to daemon')`. Insert new default path before existing `allPhases()` code: when source is provided AND `--foreground` is not set AND `--queue` is not set AND `--dry-run` is not set, import `ensureDaemon`/`daemonRequest` from `./daemon-client.js`, call `ensureDaemon(cwd)`, `POST /api/enqueue` with `{ source }`, print enqueue confirmation with sessionId and monitor URL, then `process.exit(0)`. Wrap in try/catch — on failure, warn "Daemon unavailable, falling back to foreground execution" and fall through to existing `allPhases()` code. The existing in-process code runs when `--foreground` is set, `--queue` is set, `--dry-run` is set, or daemon delegation fails.
- `src/cli/mcp-proxy.ts` — Rename `eforge_run` tool registration to `eforge_build`. Change its description to reflect enqueue-only behavior. Remove queue-mode logic (no `--queue`/`--watch` flags). Implementation: call `daemonRequest(cwd, 'POST', '/api/enqueue', { source })`, return `{ sessionId, autoBuild }`. Add new `eforge_auto_build` tool: input schema `{ action: 'get' | 'set', enabled?: boolean }`. For `get`: `daemonRequest(cwd, 'GET', '/api/auto-build')`. For `set`: `daemonRequest(cwd, 'POST', '/api/auto-build', { enabled })`. Update `ALLOWED_FLAGS` and `sanitizeFlags` if needed (may simplify since `eforge_build` no longer passes flags).
- `eforge-plugin/.claude-plugin/plugin.json` — Bump version from `0.4.0` to `0.5.0`. Remove `./skills/run/run.md` and `./skills/enqueue/enqueue.md` from commands array. Add `./skills/build/build.md`.

### Delete
- `eforge-plugin/skills/run/run.md` — Replaced by `/eforge:build`
- `eforge-plugin/skills/enqueue/enqueue.md` — Subsumed by `/eforge:build`

## Verification

- [ ] `pnpm type-check` passes with zero errors
- [ ] `pnpm test` — all existing tests pass
- [ ] `pnpm build` completes with exit code 0
- [ ] `eforge build --help` shows the `build` command with `--foreground`, `--queue`, `--watch`, `--auto`, `--verbose`, `--dry-run` options
- [ ] `eforge run --help` shows identical help as `eforge build --help` (hidden alias works)
- [ ] `eforge build <source>` without `--foreground` calls `POST /api/enqueue` and exits (when daemon is running)
- [ ] `eforge build <source> --foreground` executes the full pipeline in-process
- [ ] `eforge build <source>` with daemon unreachable warns and falls back to in-process execution
- [ ] `eforge build --queue` and `eforge build --queue --watch` retain existing in-process behavior
- [ ] MCP tool `eforge_build` is registered with enqueue-only behavior (no `--queue`/`--watch` parameters)
- [ ] MCP tool `eforge_auto_build` exists with `get`/`set` actions
- [ ] `eforge-plugin/.claude-plugin/plugin.json` version is `0.5.0`
- [ ] `eforge-plugin/.claude-plugin/plugin.json` commands array contains `./skills/build/build.md` and does NOT contain `./skills/run/run.md` or `./skills/enqueue/enqueue.md`
- [ ] `eforge-plugin/skills/build/build.md` exists and references `mcp__eforge__eforge_build`
- [ ] `eforge-plugin/skills/run/run.md` does NOT exist
- [ ] `eforge-plugin/skills/enqueue/enqueue.md` does NOT exist

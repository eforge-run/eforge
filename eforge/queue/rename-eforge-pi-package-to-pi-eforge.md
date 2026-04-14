---
title: Rename `eforge-pi` package to `pi-eforge`
created: 2026-04-14
---

# Rename `eforge-pi` package to `pi-eforge`

## Problem / Motivation

The Pi ecosystem convention is a `pi-` prefix (see `@mariozechner/pi-coding-agent`, `pi-ai`, `pi-tui`, `pi-agent-core`). Our package is named `@eforge-build/eforge-pi` (suffix form), which reads as an outlier in the Pi ecosystem. Aligning the package name with the convention helps Pi users discover and categorize it consistently.

## Goal

Rename the `@eforge-build/eforge-pi` package (and its directory) to `@eforge-build/pi-eforge` so it conforms to the Pi ecosystem's `pi-` prefix convention.

## Approach

Perform a code, directory, and docs rename only:

- npm package: `@eforge-build/eforge-pi` → `@eforge-build/pi-eforge`
- Directory: `packages/eforge-pi/` → `packages/pi-eforge/`

### 1. Directory rename (preserve git history)

```bash
git mv packages/eforge-pi packages/pi-eforge
```

### 2. Package metadata

`packages/pi-eforge/package.json:2`
- `"name": "@eforge-build/eforge-pi"` → `"name": "@eforge-build/pi-eforge"`

### 3. Publish script

`scripts/publish-all.mjs:8, 26`
- Comment mentioning `eforge-pi` → `pi-eforge`
- `"packages/eforge-pi/package.json"` → `"packages/pi-eforge/package.json"`

### 4. Documentation

`README.md:4, 72, 79, 82`
- npm badge URL, two `pi install` commands, prose mention.

`AGENTS.md:25, 26, 29`
- Path `packages/eforge-pi/package.json` → `packages/pi-eforge/package.json`
- Workspace layout list: `eforge-pi` → `pi-eforge`

`packages/pi-eforge/README.md:1, 8, 14, 37`
- Title `# @eforge-build/eforge-pi` → `# @eforge-build/pi-eforge`
- Two install commands, one prose reference.

`packages/client/README.md:9, 20, 24`
- Path `packages/eforge-pi/extensions/eforge/index.ts` → `packages/pi-eforge/...`
- Path `packages/eforge-pi/` → `packages/pi-eforge/`
- Package name `@eforge-build/eforge-pi` → `@eforge-build/pi-eforge`

`docs/architecture.md:13, 67`
- Mermaid node label `packages/eforge-pi/` → `packages/pi-eforge/`
- Prose reference on line 67.

### Critical files to modify

- `packages/eforge-pi/` (rename to `packages/pi-eforge/`)
- `packages/pi-eforge/package.json`
- `scripts/publish-all.mjs`
- `README.md`
- `AGENTS.md`
- `packages/pi-eforge/README.md`
- `packages/client/README.md`
- `docs/architecture.md`

## Scope

### In scope

- Code, directory, and docs rename as described above.

### Out of scope / Not touched

- Publishing a deprecation tombstone on the old `@eforge-build/eforge-pi` npm name (do it manually at release time if desired).
- `CHANGELOG.md` — managed by the release flow (per project convention).
- `eforge/plans/monorepo-restructuring-.../` — historical migration artifacts; leave as-is.
- `pnpm-lock.yaml` — regenerates on `pnpm install`.
- `dist/` build artifacts — rebuilt by `pnpm build`.
- Skill directory names (`packages/eforge-pi/skills/eforge-build/`, etc.) — these map to `/eforge:*` commands and are unrelated to the package name.
- `packages/engine/src/backends/pi-mcp-bridge.ts:250` contains the string `` `eforge-pi-${name}` `` — this is engine code that bridges external MCP servers into Pi AgentTools (via `pi-agent-core`), and the string is eforge's self-identifier when connecting *to* MCP servers as a client. It is unrelated to the Pi extension package and stays as-is.

## Acceptance Criteria

1. **Exhaustive grep**: `grep -r "eforge-pi" .` (excluding `node_modules/`, `dist/`, `pnpm-lock.yaml`, `CHANGELOG.md`, `eforge/plans/monorepo-restructuring-*`, and `packages/engine/src/backends/pi-mcp-bridge.ts`) returns zero matches.
2. **Workspace resolves**: `pnpm install` completes cleanly and `pnpm-lock.yaml` regenerates with `@eforge-build/pi-eforge`.
3. **Build green**: `pnpm -r build` succeeds.
4. **Type check green**: `pnpm -r type-check` succeeds.
5. **Tests green**: `pnpm test` passes.
6. **Publish dry run**: `pnpm publish-all --dry-run` successfully propagates lockstep version to `packages/pi-eforge/package.json` and stages the package under the new name.
7. **Pi install smoke test** (post-publish, optional): `pi install -l npm:@eforge-build/pi-eforge` resolves the new package locally.

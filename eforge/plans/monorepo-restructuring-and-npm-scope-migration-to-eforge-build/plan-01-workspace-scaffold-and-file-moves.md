---
id: plan-01-workspace-scaffold-and-file-moves
name: Workspace Scaffold and File Moves
depends_on: []
branch: monorepo-restructuring-and-npm-scope-migration-to-eforge-build/workspace-scaffold-and-file-moves
---

# Workspace Scaffold and File Moves

## Architecture Context

This is the foundational plan for the monorepo restructuring. It creates the target directory structure under `packages/`, moves all source files via `git mv`, creates new package.json/tsconfig.json/tsup.config.ts files for each workspace package, updates `pnpm-workspace.yaml`, transforms the root `package.json` into a private workspace orchestrator, and deletes dead code. After this plan, all files are in their final locations but imports have NOT been rewritten yet - the codebase will not build or pass tests until plan-02 completes.

This plan is intentionally separated from the import/build-config plan to keep file diffs clean. Git history preservation via `git mv` is easier to review when moves are not mixed with content edits.

## Implementation

### Overview

1. Create `tsconfig.base.json` with shared compiler options and `@eforge-build/*` path aliases
2. Create 5 new package directories under `packages/` with their config files
3. Move 162 files via `git mv` preserving directory structure
4. Delete dead code: `src/monitor/mock-server.ts`, root `tsup.config.ts`, `tsconfig.build.json`, `scripts/post-build.ts`
5. Update `pnpm-workspace.yaml` to `packages: ["packages/*"]`
6. Transform root `package.json` into `eforge-monorepo` private workspace orchestrator
7. Remove empty `src/` directory after all moves

### Key Decisions

1. **All file moves happen via `git mv` in a single commit** to preserve history and avoid conflicts with parallel changes.
2. **`src/engine/index.ts` is deleted** (not moved) - it's a 163-line barrel with zero consumers.
3. **`src/monitor/mock-server.ts` is deleted** (not moved) - 937 lines, zero imports, only referenced by the dropped `dev:mock` script.
4. **`packages/eforge-pi/` gets `git mv` from `pi-package/`** - preserves git history for all 10 files.
5. **No content changes to moved files** - import rewrites happen in plan-02. This keeps the `git mv` diff clean.

## Scope

### In Scope
- Create `packages/engine/`, `packages/monitor/`, `packages/monitor-ui/`, `packages/eforge/`, `packages/eforge-pi/` directory structures
- Create `package.json` for each new workspace package
- Create `tsconfig.json` for each new workspace package (extending `tsconfig.base.json`)
- Create `tsup.config.ts` for `packages/engine/`, `packages/monitor/`, `packages/eforge/`
- Create `tsconfig.base.json` at repo root
- Move all 162 files via `git mv`
- Delete `src/engine/index.ts` (unused barrel)
- Delete `src/monitor/mock-server.ts` (dead code)
- Delete `tsconfig.build.json`, root `tsup.config.ts`, `scripts/post-build.ts`
- Update `pnpm-workspace.yaml`
- Transform root `package.json`
- Update `packages/monitor-ui/vite.config.ts` outDir to `'dist'`

### Out of Scope
- Import rewrites in source or test files (plan-02)
- Source code modifications for `createRequire` or `EFORGE_VERSION` (plan-02)
- Documentation updates (plan-03)
- Publishing scripts (plan-02)
- Running `pnpm install` or `pnpm build` validation (deferred to plan-02 verification)

## Files

### Create
- `tsconfig.base.json` - Shared compiler options with `@eforge-build/*` path aliases; all per-package tsconfigs extend this
- `packages/engine/package.json` - `@eforge-build/engine`, private, `exports: { "./*": ..., "./package.json": ... }`, no barrel entry
- `packages/engine/tsconfig.json` - Extends `../../tsconfig.base.json`, includes `src/`
- `packages/engine/tsup.config.ts` - Glob entry `src/**/*.ts`, `dts: true`, `onSuccess` copies `src/prompts/` to `dist/prompts/` with `existsSync` guard
- `packages/monitor/package.json` - `@eforge-build/monitor`, private, `exports: { ".", "./server-main", "./*", "./package.json" }`, devDep on `@eforge-build/monitor-ui`
- `packages/monitor/tsconfig.json` - Extends `../../tsconfig.base.json`
- `packages/monitor/tsup.config.ts` - Glob entry `src/**/*.ts`, `dts: true`, `onSuccess` copies `../monitor-ui/dist/` to `dist/monitor-ui/` with `existsSync` guard
- `packages/monitor-ui/package.json` - `@eforge-build/monitor-ui`, private, `files: [dist]`
- `packages/eforge/package.json` - `@eforge-build/eforge`, v0.4.0, published, `bin: { eforge: "./dist/cli.js" }`, `bundledDependencies`, `publishConfig: { access: "public" }`
- `packages/eforge/tsconfig.json` - Extends `../../tsconfig.base.json`
- `packages/eforge/tsup.config.ts` - Single entry `src/cli.ts`, `external: [/^@eforge-build\//]`, `define: { EFORGE_VERSION }`, shebang banner
- `packages/eforge-pi/package.json` - Rewritten from `pi-package/package.json`: name `@eforge-build/eforge-pi`, `publishConfig: { access: "public" }`

### Modify
- `pnpm-workspace.yaml` - Replace three separate entries with `packages: ["packages/*"]`
- `root package.json` - Transform to `eforge-monorepo` private workspace orchestrator: remove `bin`, `exports`, `main`, `types`, `dependencies`; keep only `devDependencies` (typescript, vitest); replace scripts with `pnpm -r build`, `pnpm -r type-check`, `vitest run`, etc.; drop `dev`, `dev:trace`, `dev:mock`, `tsx` devDep
- `packages/monitor-ui/vite.config.ts` - Change `outDir` from `'../../../dist/monitor-ui'` to `'dist'` (after it's moved to `packages/monitor-ui/`)

### Delete
- `src/engine/index.ts` - Unused 163-line barrel, zero consumers
- `src/monitor/mock-server.ts` - 937 lines dead code, zero imports
- `tsconfig.build.json` - Only existed for unused `dist/types/` emit
- `tsup.config.ts` (root) - Replaced by per-package configs
- `scripts/post-build.ts` - No longer needed; per-package tsup owns post-build

### Move (via `git mv`)

**Engine (49 `.ts` files + 26 prompt `.md` files = 75 files):**
- `src/engine/**/*.ts` (excluding `index.ts`) -> `packages/engine/src/**/*.ts`
- `src/engine/prompts/*.md` -> `packages/engine/src/prompts/*.md`

**Monitor (6 `.ts` files):**
- `src/monitor/index.ts` -> `packages/monitor/src/index.ts`
- `src/monitor/server-main.ts` -> `packages/monitor/src/server-main.ts`
- `src/monitor/server.ts` -> `packages/monitor/src/server.ts`
- `src/monitor/db.ts` -> `packages/monitor/src/db.ts`
- `src/monitor/recorder.ts` -> `packages/monitor/src/recorder.ts`
- `src/monitor/registry.ts` -> `packages/monitor/src/registry.ts`

**Monitor UI (66 files):**
- `src/monitor/ui/**` -> `packages/monitor-ui/**` (preserving internal structure: `src/`, `public/`, config files)

**CLI (5 files):**
- `src/cli.ts` -> `packages/eforge/src/cli.ts`
- `src/cli/index.ts` -> `packages/eforge/src/cli/index.ts`
- `src/cli/display.ts` -> `packages/eforge/src/cli/display.ts`
- `src/cli/interactive.ts` -> `packages/eforge/src/cli/interactive.ts`
- `src/cli/mcp-proxy.ts` -> `packages/eforge/src/cli/mcp-proxy.ts`

**Pi extension (10 files):**
- `pi-package/**` -> `packages/eforge-pi/**` (preserving `extensions/`, `skills/`, `README.md`, `package.json`)

## Verification

- [ ] `ls packages/engine/src/config.ts packages/engine/src/events.ts packages/engine/src/agents/planner.ts` - all exist (engine files moved)
- [ ] `ls packages/engine/src/prompts/builder.md` - prompts moved
- [ ] `test ! -f src/engine/index.ts` - barrel deleted
- [ ] `test ! -f src/monitor/mock-server.ts` - dead code deleted
- [ ] `ls packages/monitor/src/index.ts packages/monitor/src/server-main.ts packages/monitor/src/server.ts packages/monitor/src/db.ts` - monitor files moved
- [ ] `ls packages/monitor-ui/src/App.tsx packages/monitor-ui/vite.config.ts` - monitor-ui moved
- [ ] `grep -q '"dist"' packages/monitor-ui/vite.config.ts` - outDir updated to self-contained
- [ ] `ls packages/eforge/src/cli.ts packages/eforge/src/cli/index.ts packages/eforge/src/cli/mcp-proxy.ts` - CLI files moved
- [ ] `ls packages/eforge-pi/extensions/eforge/index.ts packages/eforge-pi/README.md` - pi-package moved
- [ ] `test ! -d pi-package` - old pi-package dir gone
- [ ] `test ! -d src` - entire src/ directory removed
- [ ] `test ! -f tsconfig.build.json` - deleted
- [ ] `test ! -f tsup.config.ts` - root tsup deleted
- [ ] `test ! -f scripts/post-build.ts` - deleted
- [ ] `cat pnpm-workspace.yaml | grep 'packages/\*'` - single glob pattern
- [ ] `jq '.name' package.json` returns `"eforge-monorepo"`
- [ ] `jq '.private' package.json` returns `true`
- [ ] `jq '.bin' package.json` returns `null` - no bin at root
- [ ] `jq '.name' packages/engine/package.json` returns `"@eforge-build/engine"`
- [ ] `jq '.name' packages/monitor/package.json` returns `"@eforge-build/monitor"`
- [ ] `jq '.name' packages/eforge/package.json` returns `"@eforge-build/eforge"`
- [ ] `jq '.version' packages/eforge/package.json` returns `"0.4.0"`
- [ ] `jq '.name' packages/eforge-pi/package.json` returns `"@eforge-build/eforge-pi"`
- [ ] `jq '.name' packages/monitor-ui/package.json` returns `"@eforge-build/monitor-ui"`
- [ ] `ls tsconfig.base.json` - shared base config created
- [ ] `grep "@eforge-build/engine" tsconfig.base.json` - path aliases present
- [ ] `git log --diff-filter=R --name-status -1` shows rename operations (git history preserved)

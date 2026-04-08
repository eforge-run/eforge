---
id: plan-02-import-rewrites-build-pipeline-and-publish-scripts
name: Import Rewrites, Build Pipeline, and Publish Scripts
depends_on: [plan-01-workspace-scaffold-and-file-moves]
branch: monorepo-restructuring-and-npm-scope-migration-to-eforge-build/import-rewrites-build-pipeline-and-publish-scripts
---

# Import Rewrites, Build Pipeline, and Publish Scripts

## Architecture Context

With all files in their final locations (plan-01), this plan performs the content changes that make the monorepo buildable and testable: rewriting all internal imports to use `@eforge-build/*` package aliases, updating the source files that need runtime path resolution changes (`createRequire` for fork, `EFORGE_VERSION` for version), updating `vitest.config.ts` with resolve aliases, creating the new publish script, and renaming the existing one. After this plan, `pnpm install && pnpm build && pnpm test` must all pass.

## Implementation

### Overview

1. **Intra-package import rewrites** - Source files that moved from `src/engine/`, `src/monitor/`, and `src/cli/` now need their relative imports updated to reflect new directory depths and cross-package boundaries
2. **Cross-package import rewrites** - Imports that previously crossed package boundaries via relative paths (e.g., `src/cli/index.ts` importing from `../engine/config.js`) become `@eforge-build/engine/config` imports
3. **Test import rewrites** - All 155 imports across 66 test files rewritten from `'../src/engine/...'` and `'../src/monitor/...'` to `'@eforge-build/engine/...'` and `'@eforge-build/monitor/...'`
4. **Runtime path resolution fixes** - `createRequire` for monitor fork, `EFORGE_VERSION` for mcp-proxy
5. **vitest.config.ts** - Add `resolve.alias` entries for `@eforge-build/*` packages
6. **Publishing scripts** - New `prepare-eforge-publish.mjs`, rename and update `prepare-eforge-pi-publish.mjs`
7. **pnpm install** and build verification

### Key Decisions

1. **Imports drop `.js` extensions when switching to package aliases.** Current test imports use `.js` extensions (e.g., `from '../src/engine/config.js'`). When rewritten to `@eforge-build/engine/config`, the `.js` extension is dropped because the package's `exports` field handles resolution. Intra-package imports within engine and monitor source files retain `.js` extensions since they're still relative imports within the same package.

2. **`createRequire(import.meta.url).resolve(...)` replaces all `__dirname`-based fork resolution.** Two sites: `packages/monitor/src/index.ts::resolveServerMain()` and `packages/eforge/src/cli/index.ts` daemon start fork. Both switch to resolving `@eforge-build/monitor/server-main` via Node module resolution. The try-catch wrapping is preserved with a clear diagnostic error.

3. **`EFORGE_VERSION` compile-time define replaces runtime `package.json` read in mcp-proxy.** The `packages/eforge/tsup.config.ts` defines `EFORGE_VERSION: JSON.stringify(version)`. In `mcp-proxy.ts`, the broken runtime `readFile` of `package.json` is replaced with `declare const EFORGE_VERSION: string`.

4. **Intra-engine imports stay relative.** Files within `packages/engine/src/` continue importing each other via `./` and `../` relative paths. Only cross-package imports change to `@eforge-build/*`.

5. **`server-main.ts` import of `loadConfig` changes from `'../engine/config.js'` to `'@eforge-build/engine/config'`.** This is the one runtime function import from engine into monitor. It becomes a proper cross-package dependency.

## Scope

### In Scope
- Rewrite cross-package imports in `packages/monitor/src/server-main.ts` (engine imports)
- Rewrite cross-package imports in `packages/eforge/src/cli/index.ts` (engine + monitor imports)
- Rewrite cross-package imports in `packages/eforge/src/cli/display.ts` (engine imports)
- Rewrite cross-package imports in `packages/eforge/src/cli/interactive.ts` (engine imports)
- Rewrite cross-package imports in `packages/eforge/src/cli/mcp-proxy.ts` (client imports, version fix)
- Rewrite cross-package imports in `packages/eforge/src/cli.ts` (if it imports from engine)
- Rewrite all 155 test imports across 66 test files
- Fix `packages/monitor/src/index.ts::resolveServerMain()` to use `createRequire`
- Fix `packages/eforge/src/cli/index.ts` daemon start fork to use `createRequire`
- Fix `packages/eforge/src/cli/mcp-proxy.ts` version to use `EFORGE_VERSION`
- Update `vitest.config.ts` with `resolve.alias`
- Create `scripts/prepare-eforge-publish.mjs`
- Rename `scripts/prepare-pi-package-publish.mjs` to `scripts/prepare-eforge-pi-publish.mjs` and update paths/names
- Run `pnpm install` to regenerate lockfile for new workspace layout
- Verify `pnpm build` completes
- Verify `pnpm test` passes

### Out of Scope
- Documentation updates (plan-03)
- eforge-plugin and pi-extension skill file updates (plan-03)
- Actual npm publishing or deprecation
- Eval scenario updates

## Files

### Create
- `scripts/prepare-eforge-publish.mjs` - Stages `@eforge-build/eforge` tarball: copies `packages/eforge/dist/`, bundles `node_modules/@eforge-build/{client,engine,monitor}/dist/` from workspace, rewrites `package.json` with concrete versions, validates known subpaths exist

### Modify

**Cross-package import rewrites (source files):**
- `packages/monitor/src/server-main.ts` - Change `'../engine/config.js'` to `'@eforge-build/engine/config'`; all other imports (from `./db.js`, `./server.js`, `./registry.js`, `@eforge-build/client`) stay unchanged
- `packages/eforge/src/cli/index.ts` - Change all `'../engine/*.js'` and `'../../engine/*.js'` imports to `'@eforge-build/engine/*'`; change `'../monitor/index.js'` to `'@eforge-build/monitor'`; replace daemon start fork resolution with `createRequire` pattern
- `packages/eforge/src/cli/display.ts` - Change engine imports to `@eforge-build/engine/*`
- `packages/eforge/src/cli/interactive.ts` - Change engine imports to `@eforge-build/engine/*`
- `packages/eforge/src/cli/mcp-proxy.ts` - Change `@eforge-build/client` imports (path may need adjustment); replace runtime `package.json` version read with `EFORGE_VERSION` compile-time constant
- `packages/eforge/src/cli.ts` - Update import from `'./cli/index.js'` (stays relative, but verify path correctness after move)

**Runtime path resolution fixes:**
- `packages/monitor/src/index.ts` - Replace `resolveServerMain()` body: remove `__dirname`/`accessSync` logic; use `createRequire(import.meta.url).resolve('@eforge-build/monitor/server-main')` with try-catch producing diagnostic error "Monitor server-main entry not found. Did you run `pnpm build`?"
- `packages/eforge/src/cli/index.ts` - Replace the 20-line daemon start fork resolution block (lines 623-648 in original) with `const require = createRequire(import.meta.url); const serverMainPath = require.resolve('@eforge-build/monitor/server-main');`

**Test import rewrites (66 files):**
- All test files in `test/` with `from '../src/engine/` imports - rewrite to `from '@eforge-build/engine/` (drop `.js` extension)
- All test files in `test/` with `from '../src/monitor/` imports - rewrite to `from '@eforge-build/monitor/` or `from '@eforge-build/monitor` (for barrel imports)
- Exact list: 58 files with engine imports, 11 files with monitor imports, some overlap

**Build infrastructure:**
- `vitest.config.ts` - Add `resolve.alias` entries: `'@eforge-build/client'` -> `packages/client/src/index.ts`, `'@eforge-build/engine/'` -> `packages/engine/src/`, `'@eforge-build/monitor'` -> `packages/monitor/src/index.ts`, `'@eforge-build/monitor/'` -> `packages/monitor/src/`

**Publishing scripts:**
- `scripts/prepare-pi-package-publish.mjs` -> renamed to `scripts/prepare-eforge-pi-publish.mjs`; update `piPackagePath` from `../pi-package/` to `../packages/eforge-pi/`; update `piPackageReadmePath`, `piPackageExtensionsPath`, `piPackageSkillsPath`; change staged package name to `@eforge-build/eforge-pi`; update version source to read from `packages/eforge/package.json`

### Delete
- `scripts/prepare-pi-package-publish.mjs` - Replaced by renamed `prepare-eforge-pi-publish.mjs`

## Verification

- [ ] `pnpm install` completes with zero errors and zero "missing workspace package" warnings
- [ ] `pnpm build` (which runs `pnpm -r build`) completes with zero errors
- [ ] `ls packages/engine/dist/config.js packages/engine/dist/agents/planner.js` - engine built
- [ ] `ls packages/engine/dist/prompts/builder.md` - engine prompts copied
- [ ] `ls packages/monitor/dist/index.js packages/monitor/dist/server-main.js` - monitor built
- [ ] `ls packages/monitor/dist/monitor-ui/index.html` - monitor-ui assets copied
- [ ] `ls packages/monitor-ui/dist/index.html` - monitor-ui self-contained build
- [ ] `ls packages/eforge/dist/cli.js` - CLI built
- [ ] `pnpm test` passes with zero new failures
- [ ] `grep -rn "from ['\"]\\.\\.\/src/" test/` returns zero matches - all test imports use `@eforge-build/*`
- [ ] `grep -c "createRequire" packages/monitor/src/index.ts` returns 1+ (fork resolution updated)
- [ ] `grep -c "createRequire" packages/eforge/src/cli/index.ts` returns 1+ (daemon fork updated)
- [ ] `grep -c "EFORGE_VERSION" packages/eforge/src/cli/mcp-proxy.ts` returns 1+ (version fixed)
- [ ] `grep -c "__dirname.*server-main" packages/monitor/src/index.ts` returns 0 (old pattern gone)
- [ ] `grep -c "accessSync.*bundledPath\|accessSync.*jsPath\|accessSync.*tsPath" packages/eforge/src/cli/index.ts` returns 0 (old 20-line fallback gone)
- [ ] `pnpm -r type-check` passes with zero errors
- [ ] `ls scripts/prepare-eforge-publish.mjs` - new publish script exists
- [ ] `ls scripts/prepare-eforge-pi-publish.mjs` - renamed publish script exists
- [ ] `test ! -f scripts/prepare-pi-package-publish.mjs` - old name gone
- [ ] `node scripts/prepare-eforge-publish.mjs` completes without error
- [ ] `ls tmp/eforge-publish/dist/cli.js` - staged CLI
- [ ] `ls tmp/eforge-publish/node_modules/@eforge-build/engine/dist/agents/planner.js` - staged engine subpath
- [ ] `ls tmp/eforge-publish/node_modules/@eforge-build/engine/dist/prompts/builder.md` - staged engine prompts
- [ ] `ls tmp/eforge-publish/node_modules/@eforge-build/monitor/dist/server-main.js` - staged monitor fork target
- [ ] `ls tmp/eforge-publish/node_modules/@eforge-build/monitor/dist/monitor-ui/index.html` - staged UI assets
- [ ] `node scripts/prepare-eforge-pi-publish.mjs` completes without error
- [ ] `grep "@eforge-build/monitor/server-main" packages/monitor/src/index.ts` - resolves via package exports
- [ ] `packages/eforge/tsup.config.ts` contains `/^@eforge-build\//` in external (NOT noExternal)

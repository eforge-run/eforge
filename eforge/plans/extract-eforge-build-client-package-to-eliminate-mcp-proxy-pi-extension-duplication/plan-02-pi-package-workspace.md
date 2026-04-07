---
id: plan-02-pi-package-workspace
name: Add pi-package to workspace and migrate Pi extension
depends_on: [plan-01-create-client-package]
branch: extract-eforge-build-client-package-to-eliminate-mcp-proxy-pi-extension-duplication/pi-package-workspace
---

# Add pi-package to workspace and migrate Pi extension

## Architecture Context

Plan 1 created `@eforge-build/client` and migrated all root-package callers. This plan adds `pi-package` to the pnpm workspace so it can depend on `@eforge-build/client` via `workspace:*`, then rewrites the Pi extension to import from the shared package instead of inlining ~155 lines of daemon client code.

The publish staging script (`scripts/prepare-pi-package-publish.mjs`) must be updated to rewrite `workspace:*` references to concrete versions before `npm publish`, since workspace protocol is not valid in published packages.

## Implementation

### Overview

1. Add `pi-package` to `pnpm-workspace.yaml`.
2. Add `@eforge-build/client` as a dependency in `pi-package/package.json`.
3. Delete the inlined daemon client block (lines 17-172) from `pi-package/extensions/eforge/index.ts`.
4. Add `import { ... } from '@eforge-build/client'` to the Pi extension.
5. Update `scripts/prepare-pi-package-publish.mjs` to rewrite `workspace:*` to the root package version.

### Key Decisions

1. **`pi-package` added to workspace at the same path** - `pnpm-workspace.yaml` gets `pi-package` alongside the existing `src/monitor/ui` and the `packages/*` glob from Plan 1.

2. **Dependency goes in `dependencies`, not `peerDependencies`** - `@eforge-build/client` is a direct runtime dependency that gets bundled or resolved at install time. It is not something the consumer provides.

3. **Staging script uses `rootPackage.version` for version rewrite** - lock-step versioning. The script reads the root package.json version and replaces any `workspace:*` reference with that exact version string.

4. **The staging script must also add `@eforge-build/client` to the staged `dependencies`** - currently `pi-package/package.json` has no `dependencies` field. The staging script needs to handle the new `dependencies` field containing `workspace:*` by rewriting to the concrete version.

5. **Pi extension daemon response handling** - the inlined code returns `{ data: unknown; port: number }` from `daemonRequest`. The imported version from `@eforge-build/client` has the same signature. No cast changes needed - the Pi extension's existing response handling patterns (accessing `.data` properties directly) continue to work.

## Scope

### In Scope
- Adding `pi-package` to `pnpm-workspace.yaml`
- Adding `@eforge-build/client` dependency to `pi-package/package.json`
- Deleting the inlined daemon client block from `pi-package/extensions/eforge/index.ts`
- Adding import from `@eforge-build/client`
- Removing the sync-discipline comment
- Updating `scripts/prepare-pi-package-publish.mjs` to rewrite `workspace:*`

### Out of Scope
- Changing Pi extension tool definitions (shared tool registry is a follow-up)
- Adding SSE streaming to Pi extension
- Any changes to the eforge-plugin (Claude Code plugin side)

## Files

### Modify
- `pnpm-workspace.yaml` - Add `pi-package` entry
- `pi-package/package.json` - Add `"dependencies": { "@eforge-build/client": "workspace:*" }`
- `pi-package/extensions/eforge/index.ts` - Delete inlined client block (lines 17-172, ~155 lines), add import from `'@eforge-build/client'`, remove the "If the daemon HTTP API changes" sync-discipline comment
- `scripts/prepare-pi-package-publish.mjs` - Add `workspace:*` to concrete version rewriting for dependencies

## Implementation Details

### Pi extension import replacement

The inlined block (lines 17-172) contains:
- The sync-discipline comment (lines 17-21)
- Constants: `LOCKFILE_NAME`, `DAEMON_START_TIMEOUT_MS`, `DAEMON_POLL_INTERVAL_MS` (lines 23-35)
- Functions: `sleep`, `lockfilePath`, `legacyLockfilePath`, `tryReadLockfileAt`, `readLockfile`, `isPidAlive`, `isServerAlive`, `ensureDaemon`, `daemonRequestWithPort`, `daemonRequest` (lines 37-171)

Replace with:
```typescript
import {
  readLockfile,
  isServerAlive,
  ensureDaemon,
  daemonRequest,
} from '@eforge-build/client';
```

Only import the symbols actually used by the Pi extension code below the inlined block. The extension uses `readLockfile`, `isServerAlive`, `ensureDaemon`, and `daemonRequest` in its tool implementations.

### Staging script changes

Current script flow (lines 19-39):
1. Syncs version, homepage, repository from root
2. Sets publishConfig, files, peerDeps
3. Copies files to staging dir
4. Writes package.json

New addition after line 23 (after setting `piPackage.files`):
```javascript
// Rewrite workspace:* dependencies to concrete versions
if (piPackage.dependencies) {
  for (const [dep, ver] of Object.entries(piPackage.dependencies)) {
    if (typeof ver === 'string' && ver.startsWith('workspace:')) {
      piPackage.dependencies[dep] = rootPackage.version;
    }
  }
}
```

This handles `@eforge-build/client` and any future workspace dependencies generically.

## Verification

- [ ] `pnpm-workspace.yaml` contains `pi-package` entry
- [ ] `pi-package/package.json` has `"@eforge-build/client": "workspace:*"` in `dependencies`
- [ ] `pnpm install` succeeds from clean state
- [ ] `grep -c "Daemon client.*inlined" pi-package/extensions/eforge/index.ts` returns 0 (sync-discipline comment deleted)
- [ ] `grep -c "function readLockfile\|function isPidAlive\|function isServerAlive\|function ensureDaemon\|function daemonRequest" pi-package/extensions/eforge/index.ts` returns 0 (no inlined function definitions)
- [ ] `grep "from '@eforge-build/client'" pi-package/extensions/eforge/index.ts` returns a match
- [ ] `node scripts/prepare-pi-package-publish.mjs` succeeds
- [ ] `grep "workspace:" tmp/pi-package-publish/package.json` returns zero matches (no workspace protocol leakage)
- [ ] `grep "@eforge-build/client" tmp/pi-package-publish/package.json` returns a match with a concrete semver version (not `workspace:*`)
- [ ] `pnpm build` succeeds
- [ ] `pnpm type-check` succeeds
- [ ] `pnpm test` passes

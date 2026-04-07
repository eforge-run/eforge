---
id: plan-01-create-client-package
name: Create @eforge-build/client package and migrate callers
depends_on: []
branch: extract-eforge-build-client-package-to-eliminate-mcp-proxy-pi-extension-duplication/create-client-package
---

# Create @eforge-build/client package and migrate callers

## Architecture Context

The daemon HTTP client code is duplicated between `src/cli/mcp-proxy.ts` and `pi-package/extensions/eforge/index.ts`. This plan creates a new zero-dependency TypeScript package at `packages/client/` containing the daemon HTTP client, lockfile operations, response types for all live endpoints, and a `DAEMON_API_VERSION` constant. It migrates all root-package callers to import from the new package and deletes the old source files.

The Pi extension migration is handled in Plan 2 (separate because it requires adding `pi-package` to the workspace). Dead endpoint removal and doc updates are handled in Plan 3.

## Implementation

### Overview

1. Create `packages/client/` with package.json, tsconfig.json, tsup.config.ts, README.md, and source files.
2. Move lockfile code from `src/monitor/lockfile.ts` into `packages/client/src/lockfile.ts`.
3. Move daemon-client code from `src/cli/daemon-client.ts` into `packages/client/src/daemon-client.ts`.
4. Create `packages/client/src/api-version.ts` with `DAEMON_API_VERSION = 1`.
5. Create `packages/client/src/types.ts` with response types for all ~20 live daemon HTTP endpoints.
6. Create `packages/client/src/index.ts` barrel export.
7. Expand `pnpm-workspace.yaml` to include `packages/*`.
8. Add `@eforge-build/client` as a workspace dependency of the root package.
9. Update root `build` script to build `@eforge-build/client` first.
10. Update all callers: `src/cli/index.ts`, `src/cli/mcp-proxy.ts`, `src/monitor/server-main.ts`.
11. Update `test/monitor-shutdown.test.ts` imports and `vi.mock` target.
12. Delete `src/monitor/lockfile.ts` and `src/cli/daemon-client.ts`.

### Key Decisions

1. **Response types derived from actual handler implementations in `src/monitor/server.ts`** - each type matches the exact JSON shape the handler sends. Types that reference DB record shapes (like `RunInfo` from `getRuns()`) use standalone interfaces matching the SQL column aliases, not importing from `db.ts` (to keep zero engine deps).

2. **`daemonRequestWithPort` remains unexported** - it is a private helper in `src/cli/daemon-client.ts` today and stays private in the new package. Only `daemonRequest`, `daemonRequestIfRunning`, and `ensureDaemon` are public.

3. **`/api/config/show` typed as `ConfigShowResponse = unknown`** - the full `EforgeConfig` type has deep engine dependencies. Callers can narrow when needed.

4. **`/api/config/validate` typed as `ConfigValidateResponse`** - looking at the handler, it calls `validateConfigFile()` which returns `{ valid: boolean; errors?: string[]; config?: unknown }`. Type accordingly.

5. **Test `vi.mock` target changes from `'../src/monitor/lockfile.js'` to `'@eforge-build/client'`** - the mock now intercepts the new package import. The mock factory uses `importOriginal` to get the real implementations (for `writeLockfile`, `updateLockfile`, etc.) and only mocks `readLockfile` and `isServerAlive`.

6. **`mcp-proxy.ts` re-export line (`export { ensureDaemon, daemonRequest, daemonRequestIfRunning }`) stays** but now re-exports from the new package import rather than `./daemon-client.js`.

7. **`src/cli/index.ts` dynamic import on line ~258** changes from `await import('./daemon-client.js')` to `await import('@eforge-build/client')`.

8. **tsup `external` array for the CLI build does NOT list `@eforge-build/client`** - this is already the case (no change needed) since the CLI config only lists `@anthropic-ai/claude-agent-sdk`, `@mariozechner/*`, and `@sinclair/typebox`. The client package gets bundled into `dist/cli.js`.

9. **`packages/client/tsup.config.ts` produces ESM with declarations** - `format: ['esm']`, `dts: true`, `target: 'node22'`, entry `src/index.ts`.

10. **Legacy lockfile path handling (`LEGACY_LOCKFILE_NAME`, `legacyLockfilePath`, the fallback in `readLockfile` and `removeLockfile`) moves with the rest of the lockfile code** - the migration is a straight copy, preserving backward compatibility.

## Scope

### In Scope
- New `packages/client/` directory with all source files, build config, and README
- `pnpm-workspace.yaml` expansion to include `packages/*`
- Root `package.json` dependency and build script update
- Migrating `src/cli/index.ts`, `src/cli/mcp-proxy.ts`, `src/monitor/server-main.ts` imports
- Migrating `test/monitor-shutdown.test.ts` imports and mock target
- Deleting `src/monitor/lockfile.ts` and `src/cli/daemon-client.ts`
- Response types for all live endpoints (~20)
- `DAEMON_API_VERSION` constant

### Out of Scope
- Pi extension migration (Plan 2)
- Dead endpoint removal (Plan 3)
- Doc updates to AGENTS.md, architecture.md, roadmap.md (Plan 3)

## Files

### Create
- `packages/client/package.json` - Package manifest: `@eforge-build/client`, version `0.1.0`, type `module`, zero runtime deps, ESM exports
- `packages/client/tsconfig.json` - TypeScript config extending root, strict, declaration output
- `packages/client/tsup.config.ts` - tsup config: ESM, dts, node22 target
- `packages/client/README.md` - Brief description, consumers, rationale
- `packages/client/src/index.ts` - Barrel export re-exporting all public symbols
- `packages/client/src/lockfile.ts` - Moved from `src/monitor/lockfile.ts` (all exports preserved)
- `packages/client/src/daemon-client.ts` - Moved from `src/cli/daemon-client.ts` (public exports preserved, `daemonRequestWithPort` stays private)
- `packages/client/src/api-version.ts` - `DAEMON_API_VERSION = 1`
- `packages/client/src/types.ts` - Response types for all live daemon HTTP endpoints

### Modify
- `pnpm-workspace.yaml` - Add `packages/*` to the packages list
- `package.json` (root) - Add `"@eforge-build/client": "workspace:*"` to dependencies; update `build` script to run `pnpm --filter @eforge-build/client build` before root `tsup`
- `src/cli/index.ts` - Line 22: change import from `'../monitor/lockfile.js'` to `'@eforge-build/client'`. Line ~258: change dynamic import from `'./daemon-client.js'` to `'@eforge-build/client'`
- `src/cli/mcp-proxy.ts` - Lines 15-16: change imports from `'./daemon-client.js'` and `'../monitor/lockfile.js'` to single import from `'@eforge-build/client'`
- `src/monitor/server-main.ts` - Line 18: change import from `'./lockfile.js'` to `'@eforge-build/client'`
- `test/monitor-shutdown.test.ts` - Lines 6-12: change import from `'../src/monitor/lockfile.js'` to `'@eforge-build/client'`. Line 17-24: change `vi.mock` target and `importOriginal` type. Line 31: change import

### Delete
- `src/monitor/lockfile.ts` - Code moved to `packages/client/src/lockfile.ts`
- `src/cli/daemon-client.ts` - Code moved to `packages/client/src/daemon-client.ts`

## Implementation Details

### Response Types (`packages/client/src/types.ts`)

Types derived from reading handler implementations in `src/monitor/server.ts`:

```typescript
// GET /api/health
export interface HealthResponse {
  status: 'ok';
  pid: number;
}

// GET /api/auto-build, POST /api/auto-build
export interface AutoBuildState {
  enabled: boolean;
  watcher: {
    running: boolean;
    pid: number | null;
    sessionId: string | null;
  };
}

// GET /api/project-context
export interface ProjectContext {
  cwd: string | null;
  gitRemote: string | null;
}

// GET /api/config/show - opaque, full EforgeConfig has engine deps
export type ConfigShowResponse = unknown;

// GET /api/config/validate
export interface ConfigValidateResponse {
  valid: boolean;
  errors?: string[];
  config?: unknown;
}

// GET /api/queue (array of these)
export interface QueueItem {
  id: string;
  title: string;
  status: string;
  priority?: number;
  created?: string;
  dependsOn?: string[];
}

// GET /api/session-metadata (values in Record<string, SessionMetadata>)
export interface SessionMetadata {
  planCount: number | null;
  baseProfile: string | null;
  backend: string | null;
}

// GET /api/runs (array of these)
export interface RunInfo {
  id: string;
  sessionId?: string;
  planSet: string;
  command: string;
  status: string;
  startedAt: string;
  completedAt?: string;
  cwd: string;
  pid?: number;
}

// GET /api/latest-run
export interface LatestRunResponse {
  sessionId: string | null;
  runId: string | null;
}

// Types used within OrchestrationResponse
export type BuildStageSpec = string | string[];

export interface ReviewProfileConfig {
  strategy: string;
  perspectives: string[];
  maxRounds: number;
  evaluatorStrictness: string;
}

// GET /api/orchestration/:id
export interface OrchestrationResponse {
  plans: Array<{
    id: string;
    name: string;
    dependsOn: string[];
    branch: string;
    build?: BuildStageSpec[];
    review?: ReviewProfileConfig;
  }>;
  mode: string | null;
} // Returns null when no plan:complete event exists

// GET /api/run-summary/:id
export interface RunSummary {
  sessionId: string;
  status: 'unknown' | 'running' | 'failed' | 'completed';
  runs: Array<{
    id: string;
    command: string;
    status: string;
    startedAt: string;
    completedAt: string | null;
  }>;
  plans: Array<{
    id: string;
    status: 'running' | 'completed' | 'failed';
    branch: string | null;
    dependsOn: string[];
  }>;
  currentPhase: string | null;
  currentAgent: string | null;
  eventCounts: {
    total: number;
    errors: number;
  };
  duration: {
    startedAt: string | null;
    completedAt: string | null;
    seconds: number | null;
  };
}

// GET /api/run-state/:id
export interface RunState {
  status: 'unknown' | 'running' | 'failed' | 'completed';
  events: Array<{
    id: number;
    runId: string;
    type: string;
    planId?: string;
    agent?: string;
    data: string;
    timestamp: string;
  }>;
}

// GET /api/plans/:id (array of these)
export interface PlanInfo {
  id: string;
  name: string;
  body: string;
  dependsOn: string[];
  type: 'architecture' | 'module' | 'plan';
  build?: BuildStageSpec[];
  review?: ReviewProfileConfig;
}

// Type alias for the plans endpoint response
export type PlansResponse = PlanInfo[];

// GET /api/diff/:sessionId/:planId (bulk)
export interface DiffBulkResponse {
  files: Array<{
    path: string;
    diff: string;
  }>;
}

// GET /api/diff/:sessionId/:planId?file=path (single)
export interface DiffSingleResponse {
  diff: string | null;
}

// Union for the diff endpoint
export type DiffResponse = DiffBulkResponse | DiffSingleResponse;

// POST /api/enqueue
export interface EnqueueResponse {
  sessionId: string;
  pid: number;
  autoBuild: boolean;
}

// POST /api/cancel/:id
export interface CancelResponse {
  status: 'cancelled';
  sessionId: string;
}

// POST /api/daemon/stop
export interface StopDaemonResponse {
  status: 'stopping';
  force: boolean;
}

// POST /api/keep-alive
export interface KeepAliveResponse {
  status: 'ok';
}
```

### Lockfile migration notes

The lockfile code moves as-is. Key details:
- `LEGACY_LOCKFILE_NAME` and `legacyLockfilePath` are private helpers (not exported today, not exported in new package)
- `tryReadLockfileAt` is a private helper
- All imports are Node builtins: `node:fs` (readFileSync, writeFileSync, unlinkSync, mkdirSync, renameSync), `node:path` (dirname, resolve), `node:crypto` (randomBytes)

### Daemon-client migration notes

The daemon-client code moves as-is with one import path change:
- Old: `import { readLockfile, isServerAlive } from '../monitor/lockfile.js'`
- New: `import { readLockfile, isServerAlive } from './lockfile.js'` (sibling within the package)
- `daemonRequestWithPort` stays private (not exported from barrel)
- `spawn` import from `node:child_process` is a Node builtin

### Build script change

Root `package.json` build script changes from:
```
tsup && node --import tsx ./scripts/post-build.ts && pnpm --filter monitor-ui build && tsc -p tsconfig.build.json
```
to:
```
pnpm --filter @eforge-build/client build && tsup && node --import tsx ./scripts/post-build.ts && pnpm --filter monitor-ui build && tsc -p tsconfig.build.json
```

## Verification

- [ ] `packages/client/package.json` exists with `"name": "@eforge-build/client"`, `"version": "0.1.0"`, `"type": "module"`, and zero entries in `dependencies`
- [ ] `pnpm install` succeeds from a clean state (delete `node_modules` first)
- [ ] `pnpm --filter @eforge-build/client build` produces `packages/client/dist/index.js` and `packages/client/dist/index.d.ts`
- [ ] `packages/client/dist/index.d.ts` exports all symbols: `LockfileData`, `LOCKFILE_NAME`, `readLockfile`, `isPidAlive`, `isServerAlive`, `lockfilePath`, `writeLockfile`, `updateLockfile`, `removeLockfile`, `killPidIfAlive`, `DAEMON_START_TIMEOUT_MS`, `DAEMON_POLL_INTERVAL_MS`, `sleep`, `ensureDaemon`, `daemonRequest`, `daemonRequestIfRunning`, `DAEMON_API_VERSION`, `HealthResponse`, `AutoBuildState`, `ProjectContext`, `ConfigShowResponse`, `ConfigValidateResponse`, `QueueItem`, `SessionMetadata`, `RunInfo`, `LatestRunResponse`, `OrchestrationResponse`, `RunSummary`, `RunState`, `PlanInfo`, `PlansResponse`, `DiffResponse`, `EnqueueResponse`, `CancelResponse`, `StopDaemonResponse`, `KeepAliveResponse`, `BuildStageSpec`, `ReviewProfileConfig`
- [ ] `src/monitor/lockfile.ts` does not exist
- [ ] `src/cli/daemon-client.ts` does not exist
- [ ] `grep -r "from '../monitor/lockfile" src/` returns zero matches
- [ ] `grep -r "from './daemon-client" src/cli/` returns zero matches (except within `packages/client/`)
- [ ] `pnpm build` succeeds and produces a working `dist/cli.js`
- [ ] `pnpm type-check` succeeds
- [ ] `pnpm test` passes
- [ ] Root `package.json` contains `"@eforge-build/client": "workspace:*"` in dependencies
- [ ] Root `package.json` build script starts with `pnpm --filter @eforge-build/client build`

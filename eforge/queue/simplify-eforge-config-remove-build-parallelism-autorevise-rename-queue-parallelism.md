---
title: Simplify eforge config: remove `build.parallelism`, `autoRevise`; rename queue parallelism
created: 2026-04-01
---

# Simplify eforge config: remove `build.parallelism`, `autoRevise`; rename queue parallelism

## Problem / Motivation

Three config fields cause confusion or are unnecessary:

1. **`build.parallelism`** - Users see "parallelism" and think "builds in parallel" but it actually means "plans within a build." Since plan execution is IO-bound (LLM API calls), there is no reason to throttle - plans should run as soon as dependencies allow.
2. **`autoRevise`** - Auto-revision of stale PRDs should just always happen. A config toggle adds complexity with no real benefit.
3. **`prdQueue.parallelism`** - The name doesn't read well. A top-level `maxConcurrentBuilds` is self-explanatory and more discoverable.

Additionally, `watchPollIntervalMs` is effectively dead code (watcher uses `fs.watch`, not polling) but that cleanup is out of scope.

## Goal

Simplify the eforge config surface by removing two unnecessary fields (`build.parallelism`, `autoRevise`) and renaming one (`prdQueue.parallelism` to top-level `maxConcurrentBuilds` with a new default of `2`).

## Approach

Remove the fields from the Zod schema, resolved config type, defaults, and resolution logic. Introduce a new top-level `maxConcurrentBuilds` field (default `2`) to replace `prdQueue.parallelism`. Update all consumers in the orchestrator, eforge engine, CLI, tests, docs, plugin skill, and project config.

### Detailed Changes

### 1. `src/engine/config.ts`

**Add top-level `maxConcurrentBuilds`:**
- Schema: Add `maxConcurrentBuilds: z.number().int().positive().optional()` as a top-level field in `eforgeConfigSchema`
- `EforgeConfig` type: Add `maxConcurrentBuilds: number` as a top-level resolved field
- `DEFAULT_CONFIG`: Add `maxConcurrentBuilds: 2`
- `resolveConfig()`: Add `maxConcurrentBuilds: fileConfig.maxConcurrentBuilds ?? DEFAULT_CONFIG.maxConcurrentBuilds`

**Remove `build.parallelism`:**
- Schema (line 254): Remove `parallelism` from build zod schema
- `EforgeConfig` type (line 336): Remove `parallelism: number` from build
- `DEFAULT_CONFIG` (line 396): Remove `parallelism: availableParallelism()` from build. Remove `availableParallelism` import if unused elsewhere.
- `resolveConfig()` (line 487): Remove the `parallelism:` line from build object

**Remove `prdQueue.parallelism`:**
- Schema (line 269): Remove `parallelism` from prdQueue zod schema
- `EforgeConfig` type (line 339): Remove `parallelism: number` from prdQueue
- `DEFAULT_CONFIG` (line 399): Remove `parallelism: 1` from prdQueue
- `resolveConfig()` (line 507): Remove the `parallelism:` line from prdQueue object

**Remove `autoRevise`:**
- Schema (line 266): Remove `autoRevise: z.boolean().optional()` from prdQueue schema
- `EforgeConfig` type (line 339): Remove `autoRevise: boolean` from prdQueue
- `DEFAULT_CONFIG` (line 399): Remove `autoRevise: true` from prdQueue
- `resolveConfig()` (line 504): Remove the `autoRevise:` line from prdQueue object

**`mergePartialConfigs()`:** Add merging for the new top-level scalar field (project wins):
```typescript
if (project.maxConcurrentBuilds !== undefined || global.maxConcurrentBuilds !== undefined) {
  result.maxConcurrentBuilds = project.maxConcurrentBuilds ?? global.maxConcurrentBuilds;
}
```

### 2. `src/engine/orchestrator.ts`

- Line 59: Remove `parallelism?: number;` from `OrchestratorOptions`
- Line 152: Replace `parallelism: this.options.parallelism ?? availableParallelism()` with `parallelism: config.plans.length || 1`. Remove `availableParallelism` import.

### 3. `src/engine/eforge.ts`

**Remove build parallelism consumer:**
- Line 654: Remove `const parallelism = config.build.parallelism;`
- Line 661: Remove `parallelism,` from Orchestrator constructor call

**Remove autoRevise check:**
- Line 787: Change `if (this.config.prdQueue.autoRevise && revision)` to `if (revision)`

**Update queue parallelism consumers:**
- Line 970: Change `this.config.prdQueue.parallelism` to `this.config.maxConcurrentBuilds`
- Line 1189: Change `this.config.prdQueue.parallelism` to `this.config.maxConcurrentBuilds`

### 4. `src/cli/index.ts`

**Rework `buildConfigOverrides`:**
```typescript
function buildConfigOverrides(options: { maxConcurrentBuilds?: number; plugins?: boolean }): Partial<EforgeConfig> | undefined {
  const overrides: Partial<EforgeConfig> = {};
  if (options.maxConcurrentBuilds) overrides.maxConcurrentBuilds = options.maxConcurrentBuilds;
  if (options.plugins === false) overrides.plugins = { enabled: false };
  return Object.keys(overrides).length > 0 ? overrides : undefined;
}
```

- Remove `--parallelism` option (line 192)
- Replace `--queue-parallelism <n>` with `--max-concurrent-builds <n>` (line 193, 528)
- Update option type annotations to use `maxConcurrentBuilds` instead of `parallelism`/`queueParallelism` (lines 213, 541)

### 5. `src/cli/mcp-proxy.ts`

- Line 27: Note that `--poll-interval` passed to watcher subprocess feeds into dead code (`watchPollIntervalMs`). Out of scope - just note it.

### 6. Tests

**`test/config.test.ts`:**
- Line 12: Remove `expect(config.build.parallelism)` assertion
- Line 68: Remove `parallelism: 4` from build config
- Lines 235-241: Replace merge test for `build.parallelism` with different build field
- Lines 351, 357, 363: Remove `autoRevise` assertions
- Lines 374, 378: Remove `autoRevise` from merge test
- Add: Test that `config.maxConcurrentBuilds` defaults to `2`
- Add: Test merging of `maxConcurrentBuilds` (project wins over global)

**`test/dependency-detector.test.ts`:**
- Lines 226-227: Change from `prdQueue.parallelism` test to `maxConcurrentBuilds` test with value `2`

**`test/greedy-queue-scheduler.test.ts`:**
- Lines 41, 81, 170, 214: These construct partial configs with `prdQueue: { parallelism: N }`. Change to pass `maxConcurrentBuilds: N` at top level instead. Remove `autoRevise: false` from all.

**`test/watch-queue.test.ts`:**
- Line 56: Remove `autoRevise: false` from prdQueue config. If `parallelism` was set here, move to `maxConcurrentBuilds`.

### 7. `docs/config.md`

- Remove `parallelism: <cpu-count>` from build section. Add comment about automatic plan parallelism.
- Remove `autoRevise` and `parallelism` from prdQueue section.
- Add top-level `maxConcurrentBuilds: 2` with description.
- Rewrite "Parallelism" section: two dimensions - plan parallelism is automatic, queue concurrency via `maxConcurrentBuilds`.
- Update CLI override reference from `--queue-parallelism` to `--max-concurrent-builds`.

### 8. `docs/architecture.md`

- Line 185: Replace `build.parallelism` reference with note that plans run as soon as deps are met (IO-bound, no throttle).

### 9. `eforge-plugin/skills/config/config.md`

**Interview sections:**
- Section 2 ("Build settings"): Remove `parallelism` - just `postMergeCommands`, `maxValidationRetries`
- Section 10 ("PRD queue"): Remove `autoRevise`. Remove `parallelism` from here.
- Add new section or fold into existing: `maxConcurrentBuilds` (top-level, max concurrent builds from queue, default 2)

**Config reference:**
- Remove `parallelism: 4` from build section
- Remove `autoRevise` and `parallelism` from prdQueue section
- Add `maxConcurrentBuilds: 2` at top level with comment

### 10. `eforge/config.yaml` (own project config)

- Change `prdQueue.parallelism: 2` to top-level `maxConcurrentBuilds: 2`

### 11. `eforge-plugin/.claude-plugin/plugin.json`

- Bump plugin version from `0.5.12` to `0.5.13`

## Scope

**In scope:**
- Remove `build.parallelism` from schema, types, defaults, resolution, consumers, tests, and docs
- Remove `autoRevise` from schema, types, defaults, resolution, consumers, tests, and docs
- Remove `prdQueue.parallelism` from schema, types, defaults, resolution, consumers, tests, and docs
- Add top-level `maxConcurrentBuilds` (default `2`) to schema, types, defaults, resolution, merging, consumers, tests, and docs
- Replace CLI `--parallelism` and `--queue-parallelism` options with `--max-concurrent-builds`
- Update plugin skill interview and config reference
- Update own project config (`eforge/config.yaml`)
- Bump plugin version to `0.5.13`

**Out of scope:**
- Removing `watchPollIntervalMs` / dead polling code (noted but not addressed)

## Acceptance Criteria

1. `pnpm type-check` passes with no type errors
2. `pnpm test` passes - all tests pass
3. `pnpm build` produces a clean build
4. `build.parallelism` does not appear in config schema, types, defaults, resolution, or any consumer code
5. `autoRevise` does not appear in config schema, types, defaults, resolution, or any consumer code
6. `prdQueue.parallelism` does not appear in config schema, types, defaults, resolution, or any consumer code
7. Top-level `maxConcurrentBuilds` exists in schema, resolved type, defaults to `2`, and is used in queue scheduling and CLI
8. `mergePartialConfigs` correctly merges `maxConcurrentBuilds` with project winning over global
9. CLI exposes `--max-concurrent-builds <n>` and no longer exposes `--parallelism` or `--queue-parallelism`
10. Orchestrator uses `config.plans.length || 1` for plan-level parallelism instead of a configurable value
11. Auto-revision runs unconditionally (no `autoRevise` guard)
12. Docs (`config.md`, `architecture.md`) reflect the new config surface
13. Plugin skill config interview and reference are updated
14. `eforge/config.yaml` uses `maxConcurrentBuilds: 2` at top level
15. Plugin version bumped to `0.5.13`
16. Running the config skill init flow in another project confirms simplified questions with `maxConcurrentBuilds` surfaced at top level

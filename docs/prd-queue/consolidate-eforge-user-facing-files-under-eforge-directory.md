---
title: Consolidate eforge user-facing files under `eforge/` directory
created: 2026-03-29
status: pending
---

# Consolidate eforge user-facing files under `eforge/` directory

## Problem / Motivation

eforge's committable artifacts are scattered across multiple top-level locations: `eforge.yaml` (config), `docs/prd-queue/` (queue), and `plans/` (plan output). PRDs are transient work items, not documentation, so `docs/prd-queue/` is a misleading location. These are all eforge infrastructure and should live together, cleanly separated from the gitignored `.eforge/` runtime state. Additionally, `plan.outputDir` is defined in config but never actually consumed - all plan directory references are hardcoded as `'plans'`, making the config value dead code.

**Before:**
```
eforge.yaml          # config
docs/prd-queue/      # queue
plans/               # plan output
.eforge/             # internal state (gitignored)
```

**After:**
```
eforge/
  config.yaml        # was eforge.yaml
  queue/             # was docs/prd-queue/
  plans/             # was plans/
.eforge/             # internal state (gitignored, unchanged)
```

## Goal

Consolidate all committable eforge artifacts under a single `eforge/` directory with updated defaults, wire the previously dead `plan.outputDir` config through all consumers, and provide a legacy migration warning for projects still using `eforge.yaml`.

## Approach

Eight sequential phases, each building on the prior:

### Phase 1: Core config defaults and discovery

**`src/engine/config.ts`:**
- Change `DEFAULT_CONFIG.prdQueue.dir` from `'docs/prd-queue'` to `'eforge/queue'`
- Change `DEFAULT_CONFIG.plan.outputDir` from `'plans'` to `'eforge/plans'`
- Update `findConfigFile()` to look for `eforge/config.yaml` instead of `eforge.yaml`
- Add legacy detection: after walk-up fails, check for old `eforge.yaml` at `startDir`. If found, log a stderr warning with migration instructions. Return `null` (don't silently load it).

### Phase 2: Wire `plan.outputDir` through engine (fix dead config)

**`src/engine/pipeline.ts`:**
- Lines ~620, 664, 777: Replace `resolve(cwd, 'plans', ...)` with `resolve(cwd, ctx.config.plan.outputDir, ...)`

**`src/engine/eforge.ts`:**
- Lines ~887, 891: Replace hardcoded `'plans'` with `config.plan.outputDir` in `cleanupPlanFiles`

**`src/engine/plan.ts`:**
- Line ~491: Replace `resolve(cwd, 'plans', planSetName)` - pass `outputDir` from config

**`src/engine/compiler.ts`:**
- Line ~33: Same pattern - use config's `plan.outputDir`

**`src/engine/agents/planner.ts`:**
- Line ~330: Use config's `plan.outputDir` instead of hardcoded `'plans'`

### Phase 3: Agent prompts - add `{{outputDir}}` template variable

All prompt files that hardcode `plans/` paths need a `{{outputDir}}` variable. Each agent's `loadPrompt` call must pass the value from config.

**Prompt files:**
- `src/engine/prompts/planner.md`
- `src/engine/prompts/plan-reviewer.md`
- `src/engine/prompts/plan-evaluator.md`
- `src/engine/prompts/cohesion-reviewer.md`
- `src/engine/prompts/architecture-reviewer.md`
- `src/engine/prompts/module-planner.md`

**Agent files** (add `outputDir` to template vars):
- `src/engine/agents/planner.ts`
- `src/engine/agents/plan-reviewer.ts`
- `src/engine/agents/plan-evaluator.ts`
- `src/engine/agents/cohesion-reviewer.ts`
- `src/engine/agents/architecture-reviewer.ts`
- `src/engine/agents/module-planner.ts`

### Phase 4: Monitor server - fix hardcoded paths

**`src/monitor/server.ts`:**
- Line 508: Replace hardcoded `resolve(cwd, 'docs/prd-queue')` - add `queueDir` to server options, passed from caller using config
- Lines ~433-434: Same fix for plan directory references - add `planOutputDir` to server options

### Phase 5: CLI and MCP description strings

**`src/cli/index.ts`:**
- Line ~561: Update `eforge.yaml` reference in CLI help text
- Line ~109: Replace hardcoded `'plans'` with config value

**`src/cli/mcp-proxy.ts`:**
- Line ~515: Update `eforge.yaml` reference in MCP tool description

### Phase 6: Tests

**`test/config.test.ts`:**
- Update paths from `eforge.yaml` to `eforge/config.yaml` (create `eforge/` subdirectory in temp dirs)
- Add test for legacy migration warning: create `eforge.yaml`, call `findConfigFile()`, assert returns `null`

**`test/watch-queue.test.ts`:**
- Line 52: Update `dir: 'docs/prd-queue'` to `dir: 'eforge/queue'`

### Phase 7: Documentation

Update all references from `eforge.yaml` to `eforge/config.yaml` and `docs/prd-queue` to `eforge/queue`:
- `CLAUDE.md`
- `docs/config.md`
- `docs/hooks.md`
- `docs/roadmap.md`
- `README.md`
- `eforge-plugin/skills/config/config.md`

### Phase 8: Move project files

- `mkdir -p eforge`
- `git mv eforge.yaml eforge/config.yaml`
- `git mv docs/prd-queue eforge/queue` (if it exists, otherwise create `eforge/queue/`)
- Verify `.gitignore` doesn't exclude `eforge/` (only `.eforge/` should be ignored)

## Scope

**In scope:**
- Changing default config paths for queue directory and plan output directory
- Updating config file discovery to look for `eforge/config.yaml`
- Legacy `eforge.yaml` detection with stderr migration warning (returns `null`, does not silently load)
- Wiring the previously dead `plan.outputDir` config value through all engine consumers
- Adding `{{outputDir}}` template variable to all agent prompt files
- Fixing hardcoded paths in the monitor server
- Updating CLI help text and MCP tool descriptions
- Updating all tests to reflect new paths
- Updating all documentation references
- Moving actual project files (`eforge.yaml`, `docs/prd-queue/`) to new locations
- Ensuring `.gitignore` correctly ignores `.eforge/` but not `eforge/`

**Out of scope:**
- Changes to `.eforge/` runtime state directory (unchanged)
- Automated migration tooling beyond the stderr warning
- Any functional changes beyond path consolidation and wiring dead config

## Acceptance Criteria

1. `pnpm build` compiles without errors
2. `pnpm test` - all tests pass
3. `pnpm dev -- config validate` validates the moved config at `eforge/config.yaml`
4. `pnpm dev -- config show` shows resolved config with new default paths (`eforge/queue`, `eforge/plans`)
5. `pnpm dev -- enqueue "test prd"` creates the PRD file in `eforge/queue/`
6. Legacy warning works: temporarily renaming `eforge/config.yaml` back to `eforge.yaml` and running any eforge command produces a stderr warning with migration instructions and does not silently load the old file
7. `findConfigFile()` returns `null` when only the legacy `eforge.yaml` exists (covered by new test)
8. All hardcoded `'plans'` references in engine code use `config.plan.outputDir` instead
9. All agent prompt files use `{{outputDir}}` template variable instead of hardcoded `plans/`
10. Monitor server receives queue and plan directories from config rather than using hardcoded paths
11. All documentation files reference `eforge/config.yaml` and `eforge/queue` instead of old paths

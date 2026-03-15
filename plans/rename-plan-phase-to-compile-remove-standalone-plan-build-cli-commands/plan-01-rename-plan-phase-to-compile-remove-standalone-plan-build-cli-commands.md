---
id: plan-01-rename-plan-phase-to-compile-remove-standalone-plan-build-cli-commands
name: Rename "plan" phase to "compile", remove standalone plan/build CLI commands
depends_on: []
branch: rename-plan-phase-to-compile-remove-standalone-plan-build-cli-commands/main
---

# Rename "plan" phase to "compile", remove standalone plan/build CLI commands

## Context

The engine's "plan" phase is really plan *compilation* - taking a well-defined PRD and generating executable plan files. The creative planning happens upstream (in conversation, in a human's head). Renaming clarifies this, and removing standalone `plan`/`build` commands simplifies the CLI to a single `run` entry point that does compile + build atomically under one session.

## Changes

### 1. Type definitions — `src/engine/events.ts`

- Rename `PlanOptions` → `CompileOptions` (line 86)
- Change command union: `'plan' | 'build' | 'adopt'` → `'compile' | 'build' | 'adopt'` (line 129)
- Update comment on line 128: "one per plan/build/adopt phase" → "one per compile/build/adopt phase"

### 2. Engine core — `src/engine/eforge.ts`

- Rename method `plan()` → `compile()` (line 135)
- Parameter type: `Partial<PlanOptions>` → `Partial<CompileOptions>`
- Line 139: tracing command `'plan'` → `'compile'`
- Line 146: `command: 'plan'` → `command: 'compile'`
- Line 151: summary `'Planning complete'` → `'Compile complete'`

### 3. Engine barrel — `src/engine/index.ts`

- Line 15: re-export `CompileOptions` instead of `PlanOptions`

### 4. CLI — `src/cli/index.ts`

- **Delete** the `plan` command block (lines 137-169)
- **Delete** the `build` command block (lines 282-325)
- Line 228: `engine.plan(source, ...)` → `engine.compile(source, ...)`
- The `run` command already has `--adopt`, `--dry-run`, and all needed flags — no new flags needed

### 5. Monitor DB migration — `src/monitor/db.ts`

- Add after existing migrations: `db.exec("UPDATE runs SET command = 'compile' WHERE command = 'plan'")`
- Old records get rewritten; `adopt` and `build` stay as-is

### 6. Monitor UI — `src/monitor/ui/src/lib/session-utils.ts`

- Line 13: change `{ plan: 0, adopt: 0, run: 1, build: 2 }` → `{ compile: 0, adopt: 0, run: 1, build: 2 }`
- Line 19: update comment "sort plan before build" → "sort compile before build"

### 7. Mock server — `src/monitor/mock-server.ts`

- Lines 73, 153, 316, 368: `command: 'plan'` → `command: 'compile'`

### 8. Tests

- `test/hooks.test.ts` — lines 74, 122, 151: `command: 'plan'` → `command: 'compile'`
- `test/session.test.ts` — lines 22, 43, 80, 115, 141, 157: `command: 'plan'` → `command: 'compile'`
- `test/monitor-reducer.test.ts` and `test/monitor-wave-utils.test.ts` — only have `command: 'build'`, no changes needed

### 9. Documentation

- **CLAUDE.md**: update CLI commands section (remove `plan`/`build`, keep `run`), update monitor auto-start description, update architecture section phase references
- **README.md**: remove `eforge plan` and `eforge build` examples, add `eforge run --adopt` example, update architecture descriptions
- **docs/hooks.md**: remove "standalone `eforge plan` or `eforge build`" references, update phase names
- **eforge-plugin/spec.md**: remove `plan`/`build` from CLI reference

### Not changed

- Plan *files*, plan *sets*, plan *agents* (planner, plan-reviewer, plan-evaluator) — these refer to the artifact, not the phase
- `plan:start`, `plan:complete`, etc. event types — these are planning-domain events, not phase names
- `engine.build()` and `engine.adopt()` methods — stay as internal engine API
- `eforge-plugin/skills/plan/` — this skill creates PRDs, doesn't invoke the CLI
- `eforge-plugin/skills/run/` — already calls `eforge run`, minimal doc touch-up
- Config sections (`agents`, `build`, `plan`) — refer to configuration domains, not phases

## Implementation order

1. `events.ts` — types first (rename + union change)
2. `eforge.ts` — method rename + command strings
3. `index.ts` — barrel re-export
4. `cli/index.ts` — remove commands, update run
5. `db.ts` — migration
6. `session-utils.ts` — command ordering
7. `mock-server.ts` — mock data
8. Tests — update command strings
9. Documentation — CLAUDE.md, README.md, docs/hooks.md, spec.md

## Verification

1. `pnpm type-check` — no type errors
2. `pnpm test` — all tests pass
3. `pnpm build` — clean bundle
4. `pnpm dev -- run --help` — shows run command with --adopt flag, no plan/build commands listed
5. Confirm `pnpm dev -- plan` and `pnpm dev -- build` are not recognized commands

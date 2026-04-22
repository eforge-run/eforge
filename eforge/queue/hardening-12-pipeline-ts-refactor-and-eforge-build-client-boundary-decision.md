---
title: Hardening 12: pipeline.ts refactor and @eforge-build/client boundary decision
created: 2026-04-22
depends_on: ["hardening-04-engine-emission-hygiene"]
---

# Hardening 12: pipeline.ts refactor and @eforge-build/client boundary decision

## Problem / Motivation

Two cleanup items that benefit from landing together because they both touch boundaries that earlier PRDs have already reshaped:

1. **`packages/engine/src/pipeline.ts` contains very large async generator functions** with deep nesting:
   - `resolveAgentConfig` (~180 lines starting near line 179)
   - `validatePipeline` (~110 lines starting near line 111)
   - Each `*Stage` generator (planner / review / implement / evaluator) is 50-100+ lines

   Continuation logic, error handling, git ops, and event emission are all interleaved. After PRD 06 factors retry out, the remaining complexity is still high and makes future changes risky.

2. **`@eforge-build/client` is marked internal in `package.json` but consumed publicly** by both `eforge-plugin/` (via the MCP proxy) and `packages/pi-eforge/` (directly). This creates an ambiguity: breaking-change discipline differs for public vs internal packages, and consumers can't know which rules apply.

This PRD is lower-priority polish - fine to defer if timelines are tight.

**Metadata:**
- title: "Hardening 12: pipeline.ts refactor and @eforge-build/client boundary decision"
- scope: excursion
- depends_on: [2026-04-22-hardening-06-unified-retry-policy]

## Goal

- Pipeline stage generators are decomposed into named helpers. Each stage reads linearly.
- The client package's stance is declared and enforced: either public with stability guarantees, or internal with a narrowed export surface.

## Approach

### Part A: pipeline.ts refactor

After PRD 06 lands, retry/continuation is out of pipeline.ts. Remaining concentration is around:

- Building the context object for each stage
- Emitting pre/post-stage events
- Git operations interleaved with stage execution
- Error translation (`ReviewRejection` etc.)

Extract:

1. **Stage context builders.** For each stage (`plannerStage`, `reviewStage`, `implementStage`, `evaluatorStage`), pull the `buildStageContext` into a named helper. The stage body then becomes "build context → invoke agent (with retry) → handle result".

2. **Post-stage git ops.** The inline `exec('git', [...])` calls in pipeline.ts (e.g., lines 2077-2079 staging flows, 2111-2114 commit flows) already move to `forgeCommit` in PRD 04. What's left - diff capture, status checks - can live in a `packages/engine/src/pipeline/git-helpers.ts` file.

3. **Error translator.** The mapping of agent errors to user-facing review events / retry decisions. One helper, one test.

4. **resolveAgentConfig and validatePipeline**: split into smaller named sub-functions by concern (model resolution, thinking/effort coercion, schema validation, default application). Each under ~50 lines.

No behavior change. Pure mechanical refactor. Tests catch regressions; the agent-wiring tests already cover most paths.

Consider whether `pipeline.ts` should become a directory (`pipeline/index.ts`, `pipeline/stages.ts`, `pipeline/helpers.ts`). Decide based on whether the extracted helpers cross-reference; if they're mostly self-contained, keep one file but shorter.

### Part B: client boundary decision

Inspect current consumers:

- `packages/pi-eforge/extensions/eforge/index.ts` imports ~10 symbols from `@eforge-build/client`.
- `packages/eforge/src/cli/mcp-proxy.ts` is a sibling package but behaves like a consumer.
- `eforge-plugin/` runs the `eforge` CLI's MCP proxy, so indirectly it depends on client too.
- After PRDs 02, 07, 08, the surface expands: `API_ROUTES`, typed helpers, etc. More, not less.

Given the breadth of consumption, the current `"not intended for direct consumption"` label is out of touch with reality. Two options:

**Option 1 (recommended): declare client public.** Update `packages/client/package.json` description to: "Shared types, route constants, and daemon client helpers consumed by the eforge CLI, Claude Code plugin, and Pi extension." Add a short `packages/client/README.md` stating the stability policy:

- Public exports are stability-promised within a major version.
- Breaking changes bump the major version and are noted in the release.
- `DAEMON_API_VERSION` is bumped independently when the HTTP contract breaks.

**Option 2: narrow the public surface.** Split `@eforge-build/client` into an internal half (what the CLI uses for daemon proxy plumbing) and a public half (`@eforge-build/types` or similar with the route map, shared types, and SSE subscriber). Pi and plugin consume the public half only. More work; preferred only if there's an explicit reason to keep some client internals volatile.

Go with Option 1 unless there's a specific case for Option 2 that surfaces during implementation.

## Scope

### In scope (files touched)

- `packages/engine/src/pipeline.ts` (+ optional `pipeline/` directory split)
- `packages/engine/src/pipeline/*.ts` (new helper files)
- `packages/client/package.json` (description)
- `packages/client/README.md` (new, stability policy)
- Tests: `test/pipeline.test.ts` if it exists, otherwise `test/agent-wiring.test.ts` continues to cover

### Out of scope

- Changing pipeline semantics (ordering of stages, when events fire).
- Splitting the client package into multiple npm packages (Option 2) - only pick this if Option 1 is rejected during implementation.
- Refactoring other long files (backends, monitor server) - future PRDs.

## Acceptance Criteria

- `pnpm test && pnpm build` pass.
- Reviewing the pipeline stage functions: each stage body reads top-to-bottom without nested helper inlining; no function over ~80 lines.
- `resolveAgentConfig` and `validatePipeline` are split into smaller named sub-functions by concern (model resolution, thinking/effort coercion, schema validation, default application), each under ~50 lines.
- Stage context builders are extracted into named helpers for `plannerStage`, `reviewStage`, `implementStage`, and `evaluatorStage`.
- Post-stage git ops (diff capture, status checks) live in `packages/engine/src/pipeline/git-helpers.ts`.
- A single error translator helper maps agent errors to user-facing review events / retry decisions, with one test.
- `packages/client/README.md` exists and clearly states public-vs-breaking-change policy (public exports stability-promised within a major version; breaking changes bump the major version and are noted in the release; `DAEMON_API_VERSION` bumped independently when the HTTP contract breaks).
- `packages/client/package.json` description matches the new public stance: "Shared types, route constants, and daemon client helpers consumed by the eforge CLI, Claude Code plugin, and Pi extension."
- End-to-end build still produces identical outputs - refactor is pure structural with no behavior change.

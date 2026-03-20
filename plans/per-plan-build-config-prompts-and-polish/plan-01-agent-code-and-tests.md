---
id: plan-01-agent-code-and-tests
name: Agent Code, Pipeline Wiring, and Tests
depends_on: []
branch: per-plan-build-config-prompts-and-polish/agent-code-and-tests
---

# Agent Code, Pipeline Wiring, and Tests

## Architecture Context

After the schema change PRD, profiles are `{ description, compile }` only and per-plan `build`/`review` are required in orchestration.yaml plan entries. This plan removes dead parallel-lanes code from the planner agent, adds a `parseBuildConfigBlock` parser to common.ts, wires up module-planning pipeline interception for `<build-config>` blocks, and updates `formatProfileGenerationSection` to exclude build/review/agents from the schema docs it injects. Tests are updated in lockstep.

## Implementation

### Overview

Four changes in engine code plus two test files:

1. Delete `formatParallelLanes` from planner.ts and remove its usage in `buildPrompt()`, remove the `parallelLanes` template variable
2. Update `formatProfileGenerationSection` to strip build/review/agents from the profiles JSON and schema YAML it passes to the planner prompt
3. Add `parseBuildConfigBlock()` to common.ts
4. Wire `<build-config>` interception into the module-planning pipeline stage
5. Delete `formatParallelLanes` tests from lane-awareness.test.ts (keep `formatBuilderParallelNotice` tests)
6. Create per-plan-build-config.test.ts

### Key Decisions

1. `formatProfileGenerationSection` strips build/review/agents keys from each profile in the JSON blob it emits, and calls a new `getCompileOnlyProfileSchemaYaml()` that excludes those fields from the schema YAML. This keeps the schema generation in config.ts alongside the existing `getProfileSchemaYaml()`.
2. `parseBuildConfigBlock` follows the same pattern as other parsers in common.ts - regex-based XML extraction, JSON parse of content, Zod validation against `buildStageSpecSchema`/`reviewProfileConfigSchema`.
3. The module-planning pipeline stage intercepts `agent:message` events between `yield event` and the next iteration - parsing `<build-config>` blocks from the message text and storing results in `ctx.moduleBuildConfigs`.

## Scope

### In Scope
- Remove `formatParallelLanes` function and its export from `src/engine/index.ts`
- Remove `parallelLanes` computation from `buildPrompt()` in planner.ts
- Remove `BuildStageSpec` import from planner.ts if no longer used after removal
- Update `formatProfileGenerationSection` to exclude build/review/agents from both the profiles JSON and schema YAML
- Add `getCompileOnlyProfileSchemaYaml()` to config.ts
- Add `parseBuildConfigBlock()` to common.ts
- Wire `<build-config>` parsing into module-planning stage in pipeline.ts
- Delete `formatParallelLanes` tests from lane-awareness.test.ts
- Create `test/per-plan-build-config.test.ts` with tests for `parseOrchestrationConfig` per-plan build/review, `parseBuildConfigBlock`, and `validatePlanSet` per-plan stage name validation

### Out of Scope
- Prompt changes (plan-02)
- Monitor UI changes (plan-02)
- Plugin docs changes (plan-02)

## Files

### Modify
- `src/engine/agents/planner.ts` — Delete `formatParallelLanes` function (lines 126-139). Remove `parallelLanes` computation from `buildPrompt()` (lines 191-201) and the `parallelLanes` parameter from `loadPrompt()` call (line 210). Update `formatProfileGenerationSection` to strip build/review/agents keys from each profile value in the `profilesJson` before injecting, and use `getCompileOnlyProfileSchemaYaml()` instead of `getProfileSchemaYaml()`. Remove `BuildStageSpec` from the type import if unused.
- `src/engine/config.ts` — Add `getCompileOnlyProfileSchemaYaml()` that generates schema YAML from a copy of `resolvedProfileConfigSchema` with build/review/agents fields omitted. Cache it like `getProfileSchemaYaml()`.
- `src/engine/agents/common.ts` — Add `parseBuildConfigBlock(text: string): { build: BuildStageSpec[]; review: ReviewProfileConfig } | null` that extracts `<build-config>` XML blocks, JSON-parses content, validates with Zod schemas.
- `src/engine/pipeline.ts` — In module-planning stage (line 618-619 area), after `yield event`, check if event is `agent:message` and parse `<build-config>` blocks from the message text. Store parsed configs in `ctx.moduleBuildConfigs` keyed by `mod.id`.
- `src/engine/index.ts` — Remove `formatParallelLanes` from the export line
- `test/lane-awareness.test.ts` — Delete entire `describe('formatParallelLanes', ...)` block (lines 7-35) and the `formatParallelLanes` import

### Create
- `test/per-plan-build-config.test.ts` — Tests covering: (a) `parseOrchestrationConfig` reads per-plan build/review from YAML, (b) `parseOrchestrationConfig` throws on invalid per-plan build/review, (c) `validatePlanSet` catches invalid per-plan stage names, (d) `parseBuildConfigBlock` parses valid JSON with build+review fields, (e) `parseBuildConfigBlock` returns null on invalid/missing content

## Verification

- [ ] `pnpm type-check` passes with zero errors
- [ ] `pnpm test` passes — all existing tests plus new per-plan-build-config tests
- [ ] `formatParallelLanes` does not appear in any `.ts` file under `src/` or `test/` (excluding docs/prd-queue)
- [ ] `parseBuildConfigBlock` is exported from `src/engine/agents/common.ts`
- [ ] `getCompileOnlyProfileSchemaYaml` is exported from `src/engine/config.ts`
- [ ] `ctx.moduleBuildConfigs.set()` is called in the module-planning pipeline stage when `<build-config>` blocks are found
- [ ] `test/per-plan-build-config.test.ts` contains at least 4 test cases

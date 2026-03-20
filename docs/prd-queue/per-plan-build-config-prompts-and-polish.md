---
title: "Per-Plan Build Config: Prompts & Polish"
created: 2026-03-20
status: running
depends_on: ["per-plan-build-config-schema-change"]
---

# Per-Plan Build Config: Prompts & Polish

## Problem / Motivation

After the schema change PRD, profiles are `{ description, compile }` only and per-plan `build`/`review` are required. But prompts still don't instruct agents to generate per-plan config, the planner agent still has dead `formatParallelLanes` code, expedition module planning doesn't intercept `<build-config>` blocks, and monitor UI components still render old profile fields.

## Goal

Update prompts, agent code, monitor UI components, and plugin docs to fully support the new per-plan build config model.

## Approach

### Planner agent — `src/engine/agents/planner.ts`

- Remove `formatParallelLanes` function
- Remove parallelLanes computation from `buildPrompt()`
- Update `formatProfileGenerationSection` to exclude build/review/agents from schema docs and examples

### Common agent — `src/engine/agents/common.ts`

- Add `parseBuildConfigBlock()` for parsing `<build-config>` XML blocks from module planner output

### Pipeline — `src/engine/pipeline.ts`

- In module-planning stage, intercept `agent:message` events to parse `<build-config>` blocks and populate `ctx.moduleBuildConfigs`

Note: check if this was already wired by the foundation PRD's builder. Skip if already present.

### Planner prompt — `src/engine/prompts/planner.md`

- Add per-plan build/review instructions to orchestration.yaml format
- Document `review-cycle` as composite stage, `doc-update` for user-facing changes
- Document review config knobs (perspectives, maxRounds, evaluatorStrictness)
- Remove build/review/agents from profile generation section
- Remove `{{parallelLanes}}` template variable usage

### Module planner prompt — `src/engine/prompts/module-planner.md`

- Add `<build-config>` block emission instructions

### Monitor UI components

- `src/monitor/ui/src/components/pipeline/thread-pipeline.tsx` — ProfileHeader/StageOverview show compile-only, remove/relocate ReviewConfig
- `src/monitor/ui/src/components/timeline/event-card.tsx` — eventDetail shows compile stages only

### Test for lane-awareness — `test/lane-awareness.test.ts`

- Delete `formatParallelLanes` tests
- Update `formatBuilderParallelNotice` tests

### New test — `test/per-plan-build-config.test.ts`

- parseOrchestrationConfig reads per-plan build/review
- parseOrchestrationConfig throws on missing build/review
- validatePlanSet catches invalid per-plan stage names
- parseBuildConfigBlock parses valid JSON, returns null on invalid

### Plugin docs — `eforge-plugin/skills/config/config.md`

- Update profile examples to `{ description, compile }`
- Document per-plan build/review with review-cycle

## Acceptance Criteria

1. `pnpm type-check` passes
2. `pnpm test` passes
3. `pnpm build` succeeds
4. `formatParallelLanes` no longer exists
5. `parseBuildConfigBlock` exists in common.ts
6. Planner prompt documents per-plan build/review with review-cycle
7. Module planner prompt documents `<build-config>` block

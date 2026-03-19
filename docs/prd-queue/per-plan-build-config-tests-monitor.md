---
title: "Per-Plan Build Config: Tests, Monitor & Docs"
created: 2026-03-19
status: pending
depends_on: ["per-plan-build-config-profiles-agents-prompts"]
---

# Per-Plan Build Config: Tests, Monitor & Docs

## Problem / Motivation

After the previous two PRDs, profiles are `{ description, compile }` only and per-plan `build`/`review` are required. Tests, monitor UI, and plugin docs still reference the old profile shape with `build`/`review`/`agents` fields.

## Goal

Update all tests, fixtures, monitor UI types/components, mock server, and plugin documentation to match the new profile and per-plan build/review shape.

## Approach

### Test updates

**`test/pipeline.test.ts`**:
- `makeBuildCtx` already has `build`/`review`/`moduleBuildConfigs` fields (added by foundation PRD)
- `resolveAgentConfig` tests already use 2-arg signature (updated by foundation PRD)
- Remaining: remove `build`, `review`, `agents` from any `BUILTIN_PROFILES` spreads or profile construction that still references old profile shape

**`test/dynamic-profile-generation.test.ts`**:
- `cloneProfile` helper: remove build/review/agents from profile construction
- `resolveGeneratedProfile` tests: generated profiles only have description/compile/extends
- `validateProfileConfig` tests: remove build stage and agents validation tests

**`test/config-profiles.test.ts`**:
- Profile construction: remove build/review/agents fields
- Extension resolution tests: only description/compile/extends merge

**`test/plan-parsing.test.ts`**:
- Orchestration config fixtures: add per-plan `build` and `review` to plan entries
- Remove build/review/agents from profile sections of fixtures

**`test/lane-awareness.test.ts`**:
- `formatParallelLanes` was removed - delete these tests
- `formatBuilderParallelNotice` tests: update build arrays to use `review-cycle`

**`test/agent-wiring.test.ts`**:
- Profile construction: remove build/review/agents fields
- Add `moduleBuildConfigs: new Map()` where PipelineContext is constructed

**`test/orchestration-logic.test.ts`**:
- Profile construction: remove build/review/agents
- Orchestration config plan entries: add per-plan build/review

**`test/plan-complete-depends-on.test.ts`**:
- Orchestration config plan entries: add per-plan build/review

**`test/adopt.test.ts`**:
- Profile construction: remove build/review/agents

**`test/fixtures/orchestration/valid.yaml`**:
- Remove build/review/agents from profile section
- Add per-plan build/review to plan entries

### New test file

**`test/per-plan-build-config.test.ts`**:
1. `parseOrchestrationConfig` reads per-plan build/review correctly
2. `parseOrchestrationConfig` throws on missing build/review
3. `validatePlanSet` catches invalid per-plan stage names
4. `parseBuildConfigBlock` parses valid JSON, returns null on invalid/missing

### Monitor UI

**`src/monitor/ui/src/lib/types.ts`**:
- Remove `build`, `review`, `agents` from `ProfileConfig` type
- Profile becomes `{ description: string; compile: string[] }`

**`src/monitor/ui/src/components/pipeline/thread-pipeline.tsx`**:
- `ProfileHeader`: show only description + compile stages (remove build stage rendering)
- `StageOverview`: remove `build` prop, only show compile stages
- `ReviewConfig` component: remove or relocate (review config is now per-plan, not profile-level)

**`src/monitor/ui/src/components/timeline/event-card.tsx`**:
- `eventDetail()`: only show compile stages from the profile, not build/review/agents

**`src/monitor/ui/src/lib/reducer.ts`**:
- `profileInfo` state update: type will be automatically correct since `ProfileConfig` type changes

### Mock server

**`src/monitor/mock-server.ts`**:
- Update mock profile objects to match `{ description, compile }` shape
- Add per-plan `build`/`review` to mock plan entries

### Plugin docs

**`eforge-plugin/skills/config/config.md`**:
- Update profile documentation examples to show `{ description, compile }` only
- Document per-plan `build`/`review` config with `review-cycle` as standard composite stage

## Scope

**In scope:**
- All test file updates listed above
- New test file for per-plan build config
- Monitor UI type and component updates
- Mock server updates
- Plugin documentation updates
- Fixture updates

**Out of scope:**
- Engine source changes (completed in PRDs 1 and 2)

## Acceptance Criteria

1. `pnpm type-check` passes
2. `pnpm test` passes - all tests green
3. `pnpm build` succeeds
4. No test constructs `ResolvedProfileConfig` with `build`, `review`, or `agents` fields
5. Monitor UI `ProfileConfig` type has only `description` and `compile`
6. `test/per-plan-build-config.test.ts` exists with tests for per-plan parsing, validation, and parseBuildConfigBlock
7. `test/fixtures/orchestration/valid.yaml` has per-plan build/review in plan entries

---
id: plan-02-prompts-ui-docs
name: Prompts, Monitor UI, and Plugin Docs
depends_on: [plan-01-agent-code-and-tests]
branch: per-plan-build-config-prompts-and-polish/prompts-ui-docs
---

# Prompts, Monitor UI, and Plugin Docs

## Architecture Context

With agent code changes from plan-01 in place (no more `formatParallelLanes`, `parseBuildConfigBlock` wired up, profile generation excluding build/review/agents), this plan updates the prompts, monitor UI, and plugin docs to match the new per-plan build config model.

## Implementation

### Overview

1. Planner prompt: add per-plan build/review instructions to orchestration.yaml format, document `review-cycle` as composite stage, document review config knobs, remove `{{parallelLanes}}` template variable usage
2. Module planner prompt: add `<build-config>` block emission instructions
3. Monitor UI: make ProfileHeader/StageOverview show compile-only stages, relocate ReviewConfig
4. Event card: show compile stages only for profile events
5. Plugin config docs: update profile examples to `{ description, compile }`, document per-plan build/review

### Key Decisions

1. The planner prompt orchestration.yaml example gets per-plan `build` and `review` fields added to plan entries, with explanatory comments. `review-cycle` is documented as a composite stage that expands to `[review, review-fix, evaluate]`.
2. Module planner prompt adds a new section at the end instructing the agent to emit `<build-config>` blocks with JSON containing `build` (stage array) and `review` (review config object).
3. Monitor UI `StageOverview` component receives only `compile` stages (remove `build` prop). `ReviewConfig` moves from profile-level display to plan-level display or is removed from the header entirely - since review config is now per-plan, showing it at the profile level is misleading.

## Scope

### In Scope
- Update planner prompt orchestration.yaml format to include per-plan build/review
- Document `review-cycle` composite stage and review config knobs in planner prompt
- Remove `{{parallelLanes}}` from planner prompt
- Add `<build-config>` emission instructions to module planner prompt
- Update `StageOverview` in thread-pipeline.tsx to show compile stages only
- Remove or relocate `ReviewConfig` from `ProfileHeader` in thread-pipeline.tsx
- Update `eventDetail` in event-card.tsx to show compile stages only for `plan:profile` events
- Update eforge-plugin config skill docs

### Out of Scope
- Agent code changes (plan-01)
- Test changes for agent code (plan-01)

## Files

### Modify
- `src/engine/prompts/planner.md` — In the orchestration.yaml format section (line 293+), add `build` and `review` fields to each plan entry in the YAML example. Add a new subsection after "Validation Commands" documenting per-plan build/review config: what fields are available, `review-cycle` as a composite stage alias for `[review, review-fix, evaluate]`, review config knobs (strategy, perspectives, maxRounds, evaluatorStrictness). Remove `{{parallelLanes}}` template variable (line 85).
- `src/engine/prompts/module-planner.md` — Add a new section before "Quality Criteria" (around line 135) titled "Build Configuration" instructing the agent to emit a `<build-config>` block with JSON content containing `build` (array of stage specs) and `review` (object with strategy, perspectives, maxRounds, evaluatorStrictness). Include an example block and explain this determines how the module's plan is built post-merge.
- `src/monitor/ui/src/components/pipeline/thread-pipeline.tsx` — Update `StageOverview` to accept only `compile` stages (remove `build` prop). Update `ProfileHeader` to pass only `compile` to `StageOverview`. Remove `ReviewConfig` from `ProfileHeader` (review config is now per-plan, not profile-level).
- `src/monitor/ui/src/components/timeline/event-card.tsx` — In `eventDetail` for `plan:profile` case, remove the `Build:` line (line 92) and the review config lines (lines 93-96). Show only compile stages and agent overrides.
- `eforge-plugin/skills/config/config.md` — Update the profile example (lines 133-150) to show `{ description, compile }` only — remove `build`, `agents`, `review` from the profile example. Add a note explaining that build stages and review config are now per-plan in orchestration.yaml. Update the interview section text for "Profiles" (line 42-43) to reflect compile-only profiles.

## Verification

- [ ] `pnpm type-check` passes
- [ ] `pnpm build` succeeds
- [ ] `{{parallelLanes}}` does not appear in `src/engine/prompts/planner.md`
- [ ] `src/engine/prompts/planner.md` contains the string `review-cycle` in the orchestration.yaml format section
- [ ] `src/engine/prompts/planner.md` orchestration.yaml example includes `build:` and `review:` fields under plan entries
- [ ] `src/engine/prompts/module-planner.md` contains the string `<build-config>`
- [ ] `ReviewConfig` component is not rendered inside `ProfileHeader` in thread-pipeline.tsx
- [ ] `eventDetail` for `plan:profile` does not include a `Build:` line in event-card.tsx
- [ ] `eforge-plugin/skills/config/config.md` profile example does not contain `build:` or `review:` at the profile level

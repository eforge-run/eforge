---
id: plan-01-fix-errand-bias
name: Fix Planner Prompt Errand Bias and Profile Table Enhancement
depends_on: []
branch: fix-planner-profile-selection-errand-bias/fix-errand-bias
---

# Fix Planner Prompt Errand Bias and Profile Table Enhancement

## Architecture Context

The planner agent (`src/engine/agents/planner.ts`) generates a prompt from `src/engine/prompts/planner.md` with template variables. Profile descriptions are injected via `{{profiles}}` using `formatProfileDescriptions()`. The planner LLM selects a profile based on the prompt guidance, and profile choice determines which compile stages run - errand's `['prd-passthrough']` skips plan-review-cycle entirely, meaning plans go straight to build without quality review.

## Implementation

### Overview

Fix five sources of errand bias in the planner prompt and enhance `formatProfileDescriptions()` to include a "Pipeline Effect" column so the LLM understands the consequences of each profile selection.

### Key Decisions

1. **Excursion as default** - Position excursion as the default profile for most feature work and refactors, with errand reserved for trivial changes. This ensures non-trivial work goes through plan review.
2. **Consequence transparency** - Add a "Pipeline Effect" column to `formatProfileDescriptions()` that maps well-known profile names to their pipeline consequences (errand -> skips plan review, excursion -> includes plan review, expedition -> full architecture review). Custom profiles fall back to showing their compile stage list.
3. **Decouple mode from plan count** - The `mode` field in orchestration.yaml matches the selected profile name, not the plan count. Single-plan excursions are valid.

## Scope

### In Scope
- Rewrite profile selection section in `planner.md` (lines 53-69 area, the content around `{{profiles}}`)
- Remove "(errand)" / "(excursion)" parentheticals and "This is the common case" from plan count guidance (line 95)
- Decouple `mode` field from plan count (line 339)
- Neutralize orchestration.yaml example by replacing hardcoded `mode: errand` with placeholder (line 303)
- Add "Pipeline Effect" column to `formatProfileDescriptions()` in `planner.ts`
- Update existing tests in `test/agent-wiring.test.ts` that assert on the table format

### Out of Scope
- Pipeline mechanics (compile stage execution, profile resolution)
- Changes to profile definitions or `BUILTIN_PROFILES`
- Changes to any agents other than the planner
- Changes to `formatProfileGenerationSection()` (already uses excursion in its example)

## Files

### Modify
- `src/engine/prompts/planner.md` - Four prompt changes:
  1. Add structured profile selection guidance after `{{profiles}}` injection (lines 57-69): concrete errand criteria (typo fixes, single-line config changes, single-file bug fixes with obvious root cause), state that errand skips plan review, position excursion as default, add tiebreaker favoring excursion
  2. Remove "This is the common case." and `(errand)` / `(excursion)` parentheticals from plan count guidance (line 95)
  3. Replace `mode: errand` with `mode: {selected profile name}` in orchestration.yaml example (line 303)
  4. Change line 339 from `mode must match the plan count: errand for 1 plan, excursion for 2-3 plans` to `mode must match the selected profile name`

- `src/engine/agents/planner.ts` - Enhance `formatProfileDescriptions()` (lines 57-65):
  Add a third column "Pipeline Effect" to the markdown table. Map well-known profile names:
  - `errand` -> "Skips plan review - plan goes directly to build"
  - `excursion` -> "Includes plan review before build"
  - `expedition` -> "Full architecture review, module planning, and cohesion review"
  - `docs` -> "Skips plan review and code review"
  - Any other profile -> show compile stages as comma-separated list (e.g., "Stages: planner, plan-review-cycle")

- `test/agent-wiring.test.ts` - Update `formatProfileDescriptions` test assertions (lines 219-238):
  - Update header assertion from `| Profile | Description |` to `| Profile | Description | Pipeline Effect |`
  - Update row assertions to include the pipeline effect column
  - Add a test case for a custom profile that falls back to showing compile stages

## Verification

- [ ] `pnpm type-check` exits with code 0
- [ ] `pnpm test` exits with code 0
- [ ] The string "This is the common case" does not appear in `src/engine/prompts/planner.md`
- [ ] The strings `(errand)` and `(excursion)` do not appear within the "Single plan" or "Multiple plans" guidance in `src/engine/prompts/planner.md`
- [ ] Line 339 area no longer contains `errand for 1 plan` or `excursion for 2-3 plans`
- [ ] The orchestration.yaml example in the prompt uses `mode: {selected profile name}` instead of `mode: errand`
- [ ] The profile selection section contains the phrase "typo fix" (errand criterion)
- [ ] The profile selection section contains the phrase "When in doubt between errand and excursion, choose excursion"
- [ ] The profile selection section states that errand skips plan review
- [ ] `formatProfileDescriptions()` output for a profile map containing "errand" includes the string "Pipeline Effect" in the header
- [ ] `formatProfileDescriptions()` output for "errand" profile includes "Skips plan review"
- [ ] `formatProfileDescriptions()` output for "excursion" profile includes "plan review"
- [ ] `formatProfileDescriptions()` output for a custom profile with compile `['planner', 'plan-review-cycle']` includes "Stages:"

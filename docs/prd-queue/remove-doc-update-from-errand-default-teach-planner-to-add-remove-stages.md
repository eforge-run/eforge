---
title: Remove `doc-update` from errand default + teach planner to add/remove stages
created: 2026-03-19
status: pending
---



# Remove `doc-update` from errand default + teach planner to add/remove stages

## Problem / Motivation

The errand profile includes `doc-update` in its default build stages, running in parallel with `implement`. For small, self-contained changes this is almost always wasted work - the doc-updater spends ~100k tokens checking every doc file only to conclude nothing needs updating. Meanwhile, the planner generates custom profiles but never thinks to strip unnecessary stages because the prompt only shows examples of overriding `review` settings, with no guidance about modifying the build pipeline.

## Goal

Lean out the errand default build stages by removing `doc-update`, and give the planner explicit guidance about when to add or remove pipeline stages in custom profiles.

## Approach

Two-part fix:

### 1. Remove `doc-update` from errand build stages

**File**: `src/engine/config.ts` (line 195-197)

Create a separate build stage constant for the errand profile without `doc-update`:

```typescript
const ERRAND_BUILD_STAGES = Object.freeze([
  'implement', 'review', 'review-fix', 'evaluate',
]) as unknown as BuildStageSpec[];
```

Note: `implement` is no longer in a parallel group since there's nothing to run alongside it.

Update the errand profile (line 200-206) to use `ERRAND_BUILD_STAGES` instead of `DEFAULT_BUILD_STAGES`. The existing `DEFAULT_BUILD_STAGES` (which includes `doc-update` in parallel with `implement`) remains unchanged for excursion and expedition profiles.

### 2. Add planner guidance about stage customization

**File**: `src/engine/agents/planner.ts` — `formatProfileGenerationSection()` (line 104-108)

Add guidance to the Rules section about adding/removing build stages:

```
- You can override `compile` and `build` to add or remove pipeline stages
- Add `doc-update` (parallel with `implement`) when the change touches public APIs, config schemas, or user-facing behavior that docs reference
- Remove stages that add no value — e.g., for a one-line internal fix, `doc-update` is wasted work
- Use parallel groups `["implement", "doc-update"]` when stages can run concurrently
```

### 3. Update CLAUDE.md

Update the errand profile description to reflect the new build stages:

```
- **errand** — Small, self-contained changes. Compile: `[prd-passthrough]`. Build: `[implement, review, review-fix, evaluate]`.
```

## Scope

**In scope:**
- Modifying the errand profile's default build stages in `src/engine/config.ts`
- Adding stage customization guidance to the planner prompt in `src/engine/agents/planner.ts`
- Updating CLAUDE.md to reflect the new errand profile defaults

**Out of scope:**
- Changing excursion or expedition profile defaults (they keep `doc-update` in parallel with `implement`)
- Modifying any other agent prompts or pipeline logic
- Changes to how `doc-update` itself works

## Acceptance Criteria

- `BUILTIN_PROFILES.errand.build` is `['implement', 'review', 'review-fix', 'evaluate']` — no `doc-update`, no parallel group
- `BUILTIN_PROFILES.excursion.build` and `BUILTIN_PROFILES.expedition.build` still include `['implement', 'doc-update']` as a parallel group
- `pnpm type-check` passes
- `pnpm test` passes — existing profile tests use `BUILTIN_PROFILES.errand.build` dynamically, so they should adapt automatically
- The planner prompt (output of `formatProfileGenerationSection()`) includes guidance about adding/removing build stages, including when to add `doc-update` and how to use parallel groups
- CLAUDE.md errand profile description reads: `Build: [implement, review, review-fix, evaluate]`

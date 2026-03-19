---
id: plan-01-errand-stages-and-planner-guidance
name: Remove doc-update from errand and add planner stage guidance
depends_on: []
branch: remove-doc-update-from-errand-default-teach-planner-to-add-remove-stages/errand-stages-and-planner-guidance
---

# Remove doc-update from errand and add planner stage guidance

## Architecture Context

The errand profile currently shares `DEFAULT_BUILD_STAGES` with excursion and expedition, which includes `doc-update` in a parallel group with `implement`. For errands - small, self-contained changes - the doc-updater is almost always wasted work (~100k tokens to conclude nothing needs updating). The errand profile needs its own build stage constant without `doc-update`, and the planner needs guidance about when to add or remove pipeline stages in custom profiles.

## Implementation

### Overview

Three changes: (1) add an `ERRAND_BUILD_STAGES` constant and wire it into the errand profile, (2) add stage customization guidance to the planner's profile generation prompt, (3) update CLAUDE.md to reflect the new errand defaults.

### Key Decisions

1. Create a separate `ERRAND_BUILD_STAGES` constant rather than parameterizing `DEFAULT_BUILD_STAGES` - keeps it simple and explicit, and `DEFAULT_BUILD_STAGES` remains unchanged for excursion/expedition.
2. `implement` becomes a flat string (not a parallel group) in the errand build stages since there's nothing to run alongside it.

## Scope

### In Scope
- New `ERRAND_BUILD_STAGES` constant in `src/engine/config.ts`
- Errand profile uses `ERRAND_BUILD_STAGES` instead of `DEFAULT_BUILD_STAGES`
- Planner prompt gains stage customization guidance in `formatProfileGenerationSection()`
- CLAUDE.md errand profile description updated

### Out of Scope
- Changing excursion or expedition profile defaults
- Modifying any other agent prompts or pipeline logic
- Changes to how `doc-update` itself works

## Files

### Modify
- `src/engine/config.ts` — Add `ERRAND_BUILD_STAGES` constant (flat list without `doc-update`), update errand profile to use it
- `src/engine/agents/planner.ts` — Add stage customization guidance to `formatProfileGenerationSection()` Rules section
- `CLAUDE.md` — Update errand profile description to `Build: [implement, review, review-fix, evaluate]`

## Verification

- [ ] `BUILTIN_PROFILES.errand.build` equals `['implement', 'review', 'review-fix', 'evaluate']` - no `doc-update`, no parallel group
- [ ] `BUILTIN_PROFILES.excursion.build` and `BUILTIN_PROFILES.expedition.build` still include `['implement', 'doc-update']` as a parallel group (unchanged `DEFAULT_BUILD_STAGES`)
- [ ] `pnpm type-check` passes
- [ ] `pnpm test` passes - existing profile tests reference `BUILTIN_PROFILES.errand.build` dynamically so they adapt
- [ ] The planner prompt output from `formatProfileGenerationSection()` includes guidance about adding/removing build stages, when to add `doc-update`, and how to use parallel groups
- [ ] CLAUDE.md errand profile description reads `Build: [implement, review, review-fix, evaluate]`

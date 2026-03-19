---
id: plan-01-rewrite-stage-customization
name: Rewrite Stage Customization Guidance
dependsOn: []
branch: plan-improve-planner-guidance-for-doc-update-stage-inclusion/rewrite-stage-customization
---

# Rewrite Stage Customization Guidance

## Architecture Context

The planner agent in `src/engine/agents/planner.ts` contains a `formatProfileGenerationSection()` function that builds the prompt guiding the planner's profile generation decisions. The `### Stage Customization` section within this function currently frames `doc-update` inclusion as a profile-tier decision ("errands skip it"), which conflicts with the work-characteristics signal ("API changes need it"). This causes the planner to omit `doc-update` when extending `errand` even for work that adds user-facing API surface.

## Implementation

### Overview

Replace the `### Stage Customization` section (lines 110-118 of the template string in `formatProfileGenerationSection()`) with new text that frames `doc-update` inclusion around work characteristics instead of profile tier.

### Key Decisions

1. Lead with the positive inclusion criteria (user-facing surface area changes) so it's the primary signal, regardless of base profile
2. Frame the omission case around work characteristics too (purely internal changes) rather than profile identity

## Scope

### In Scope
- Rewriting the `### Stage Customization` section in `formatProfileGenerationSection()` within `src/engine/agents/planner.ts`

### Out of Scope
- Other planner prompt sections
- Stage registry, pipeline logic, or profile resolution code
- Built-in profile definitions in `src/engine/config.ts`

## Files

### Modify
- `src/engine/agents/planner.ts` — Replace the `### Stage Customization` section (lines 110-118 of the template string) with new guidance that frames `doc-update` as a work-characteristics decision

The exact replacement text for lines 110-118:

```
### Stage Customization

Build stages control the post-implementation pipeline. You can add, remove, or reorder stages in your generated profile to match the work's needs.

**Adding `doc-update`**: Include `doc-update` when the work adds or changes user-facing surface area — new API endpoints, modified request/response contracts, CLI flags, configuration options, or behavioral changes that users or integrators would notice. This applies regardless of which base profile you extend. Place it in a parallel group with `implement`: `[["implement", "doc-update"], "review", "review-fix", "evaluate"]`.

**Omitting `doc-update`**: Skip it for purely internal changes — refactors, bug fixes with no API surface change, test-only additions, or dependency updates. The overhead (~100k tokens) isn't justified when there's nothing user-facing to document.

**Parallel groups**: Wrap stage names in an inner array to run them concurrently. Only stages with no data dependencies should be parallelized. Example: `[["implement", "doc-update"], "review"]` runs implement and doc-update in parallel, then review sequentially after both complete.
```

## Verification

- [ ] The `### Stage Customization` section in `formatProfileGenerationSection()` contains no reference to "errands" or profile tiers as a reason to skip `doc-update`
- [ ] The `doc-update` inclusion guidance mentions "user-facing surface area" as the decision criterion
- [ ] The `doc-update` omission guidance mentions "purely internal changes" as the criterion, not profile tier
- [ ] Parallel group syntax (`[["implement", "doc-update"], ...]`) is documented in the section
- [ ] `pnpm build` exits with code 0
- [ ] `pnpm test` exits with code 0

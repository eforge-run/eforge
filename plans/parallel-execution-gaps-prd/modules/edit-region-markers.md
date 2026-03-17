# Edit Region Markers

## Architecture Reference

This module implements [Edit Region Markers] and [Between edit-region-markers and the planning pipeline] from the architecture.

Key constraints from architecture:
- Region markers are a prompt-level convention enforced at three levels: planner/module-planner, builder, and cohesion reviewer
- No new events, types, or pipeline stages needed - this is purely prompt engineering plus cohesion reviewer enhancement
- Markers use `// --- eforge:region {module-id} ---` / `// --- eforge:endregion {module-id} ---` format
- Markers are instructions in the plan, not code the planner writes - the builder writes actual code within designated regions
- Post-build cleanup is optional and deferred - markers are benign comments if left in place

## Scope

### In Scope
- Planner prompt additions to detect shared files and emit region marker instructions in plan output during expedition planning
- Module-planner prompt additions to designate region boundaries for shared files identified during architecture planning
- Builder prompt additions instructing builders to only edit within their assigned regions
- Cohesion reviewer prompt additions to validate that region markers across plans don't overlap
- Unit tests for region overlap detection logic

### Out of Scope
- Automated code-level enforcement of region boundaries (AST analysis, git hook validation)
- Post-build cleanup stage to remove marker comments
- Region markers for non-TypeScript/JavaScript languages
- Runtime validation that builder edits stayed within declared regions
- New event types or pipeline stages

## Implementation Approach

### Overview

Edit region markers prevent merge conflicts between same-wave plans by giving each plan non-overlapping ownership of sections within shared files. The mechanism is entirely prompt-driven: planners identify shared files and designate regions, builders respect region boundaries, and the cohesion reviewer validates that regions don't overlap.

The implementation touches four prompt files and extends the cohesion reviewer's file overlap detection to include region awareness. No new TypeScript types, events, or pipeline stages are introduced.

### Key Decisions

1. **Prompt-only enforcement, no code-level validation** - The architecture explicitly states "not enforced by code, but by instructing planners and builders to respect region boundaries." This keeps implementation lightweight. The cohesion reviewer validates region declarations in plan files (a text-level check), not actual code output.

2. **Region markers in plan file prose, not YAML frontmatter** - Regions are declared in the "Files > Modify" section of plan files as inline annotations. This keeps them close to the file references they annotate and avoids schema changes to `PlanFile` or frontmatter parsing in `plan.ts`. Example: `` `src/index.ts` — add auth exports `[region: auth-module, after existing exports]` ``

3. **Cohesion reviewer validates regions via its existing overlap map** - The cohesion reviewer already builds a `file_path -> [plan_ids]` overlap map. The new prompt instructions extend this: when overlaps are detected, the reviewer checks whether both plans declare non-overlapping regions for that file. If they do, the overlap is downgraded from "conflict" to "safe (regions declared)". If they don't, it remains a conflict.

4. **Planner identifies shared files during architecture phase** - For expeditions, the planner writes the architecture document before module planning begins. The architecture document's integration contracts section is the natural place to declare which files will be shared and how regions divide them. Module planners then reference these declarations.

## Files

### Create

None.

### Modify

- `src/engine/prompts/planner.md` — Add a new section under "Phase 4: Plan Generation > Expedition" instructing the planner to identify shared files across modules and declare edit region boundaries in `architecture.md`. Add region marker format specification and examples showing how to annotate shared barrel files, config files, and route registries.

- `src/engine/prompts/module-planner.md` — Add a section after "Module Plan Format" instructing the module planner to: (1) check the architecture document for shared file declarations, (2) include region annotations in the "Files > Modify" section for any file that another module also touches, (3) use the `// --- eforge:region {module-id} ---` comment format in code examples within the plan.

- `src/engine/prompts/builder.md` — Add a rule to "Implementation Rules" (after rule 4 "Modify files listed under Modify") instructing the builder to: (1) look for region markers (`eforge:region`) in existing files, (2) only edit code within its plan's declared region, (3) never modify or remove another plan's region markers, (4) when creating new code in a shared file, wrap it in region markers matching the plan's module ID.

- `src/engine/prompts/cohesion-reviewer.md` — Extend "Review Categories > 1. File Overlap Detection" with a new subsection on region marker validation. The reviewer must: (1) when two plans list the same file, check if both plans declare non-overlapping edit regions for that file, (2) mark as `critical / cohesion` if regions overlap or are not declared for a shared file that has no dependency relationship, (3) mark as `safe` if regions are declared and non-overlapping regardless of dependency relationship, (4) validate that region IDs in plans match the plan's module ID.

## Testing Strategy

### Unit Tests

- **Region overlap detection** (`test/edit-region-markers.test.ts`): Test the cohesion reviewer's region-aware overlap logic by constructing plan file content with various region annotation patterns and verifying correct classification:
  - Two plans with non-overlapping regions on the same file -> no issue
  - Two plans with overlapping regions on the same file -> critical/cohesion issue
  - Two plans sharing a file where one declares a region and the other does not -> critical/cohesion issue
  - Two plans sharing a file with a dependency relationship and no regions -> safe (existing behavior preserved)
  - Region ID mismatch (plan uses a region ID that doesn't match its module ID) -> warning/cohesion issue

Note: Since regions are enforced via prompts and validated by the cohesion reviewer (an LLM agent), the "unit tests" here validate the expected behavior described in the prompts by testing example plan content against the overlap detection criteria. The actual enforcement is prompt-based - these tests document the expected classification rules.

### Integration Tests

None needed. Region markers are a prompt convention validated by agent behavior. Integration testing happens through the eval harness (`eval/`) with expedition scenarios that include shared files.

## Verification

- [ ] `src/engine/prompts/planner.md` contains a section on shared file identification and edit region declaration for expedition mode, including the `// --- eforge:region {module-id} ---` format
- [ ] `src/engine/prompts/module-planner.md` contains instructions to check architecture for shared files and annotate region boundaries in the "Files > Modify" section
- [ ] `src/engine/prompts/builder.md` contains a rule referencing `eforge:region` markers with instructions to only edit within the plan's declared region and to never modify another plan's region markers
- [ ] `src/engine/prompts/cohesion-reviewer.md` "File Overlap Detection" section includes region marker validation criteria that distinguish between "regions declared and non-overlapping" (safe) vs "regions missing or overlapping" (critical/cohesion)
- [ ] `pnpm type-check` passes (no TypeScript files are created or modified, but validates no prompt template variable breakage)
- [ ] `pnpm build` succeeds
- [ ] Each prompt modification is self-contained within the existing prompt structure - no new template variables (`{{...}}`) are introduced

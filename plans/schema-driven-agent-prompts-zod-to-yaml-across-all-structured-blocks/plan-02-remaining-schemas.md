---
id: plan-02-remaining-schemas
name: Wire Remaining Schemas into Prompts and Types
depends_on: [plan-01-schemas-and-review-issue]
branch: schema-driven-agent-prompts-zod-to-yaml-across-all-structured-blocks/remaining-schemas
---

# Wire Remaining Schemas into Prompts and Types

## Architecture Context

Plan 1 created `schemas.ts` with all Zod schemas and the `getSchemaYaml()` utility, and wired ReviewIssue into the 7 reviewer prompts. This plan wires the remaining schemas (EvaluationVerdict, Clarification, Staleness, Module, PlanFile frontmatter) into their respective prompts and swaps the remaining hand-written interfaces for schema-derived types.

## Implementation

### Overview

Apply the schema-driven pattern to: (a) EvaluationVerdict across 3 evaluator prompts, (b) Clarification + Module + PlanFile frontmatter in the planner prompt, and (c) Staleness in the staleness-assessor prompt. Each follows the same pattern: import the convenience getter from `schemas.ts`, pass the schema YAML as a template variable to `loadPrompt()`, add a `{{schema_variable}}` placeholder in the prompt, and swap the hand-written interface for a `z.output<>` type alias.

### Key Decisions

1. **Type aliases replace interfaces in-place** - `EvaluationVerdict` and `EvaluationEvidence` in `builder.ts`, `StalenessVerdict` in `common.ts`, `ClarificationQuestion` and `ExpeditionModule` in `events.ts` all become `z.output<>` re-exports from `schemas.ts`.
2. **Evaluator schema YAML covers both verdict structure and evidence structure** - A single `{{evaluation_schema}}` variable documents both the `<verdict>` attributes and the `<staged>/<fix>/<rationale>/<if-accepted>/<if-rejected>` child elements.
3. **Planner prompt gets 3 schema variables** - `{{clarification_schema}}`, `{{module_schema}}`, `{{plan_frontmatter_schema}}` are each placed near their respective format documentation sections.
4. **PlanFile frontmatter schema** - Covers the YAML frontmatter fields (id, name, depends_on, branch, migrations) not the markdown body. Since this is YAML not XML, the schema YAML documents field names and types for the frontmatter block.
5. **`StalenessVerdict` in common.ts** - The `VALID_STALENESS_VERDICTS` set and the interface are replaced by the schema. The parser can optionally use `safeParse()` but the primary goal is type derivation and prompt documentation.

## Scope

### In Scope
- Replace `EvaluationVerdict` and `EvaluationEvidence` interfaces in `builder.ts` with `z.output<>` type aliases
- Replace `StalenessVerdict` interface in `common.ts` with `z.output<>` type alias
- Replace `ClarificationQuestion` and `ExpeditionModule` interfaces in `events.ts` with `z.output<>` type aliases
- Add `{{evaluation_schema}}` to evaluator.md, plan-evaluator.md, cohesion-evaluator.md
- Add `{{clarification_schema}}`, `{{module_schema}}`, `{{plan_frontmatter_schema}}` to planner.md
- Add `{{staleness_schema}}` to staleness-assessor.md
- Update `builderEvaluate()` in builder.ts to pass evaluation schema YAML
- Update `runPlanEvaluate()` in plan-evaluator.ts to pass evaluation schema YAML
- Update `runCohesionEvaluate()` in cohesion-evaluator.ts to pass evaluation schema YAML
- Update `buildPrompt()` in planner.ts to pass clarification, module, plan frontmatter schema YAMLs
- Update `runStalenessAssessor()` in staleness-assessor.ts to pass staleness schema YAML
- Add tests to `test/schemas.test.ts` for remaining schemas (evaluation, clarification, staleness, module, plan frontmatter)

### Out of Scope
- Adding `safeParse()` validation to parsers (optional future work)
- Modifying the module-planner.md prompt for plan frontmatter (the planner.md covers the primary frontmatter documentation; module-planner.md can be a follow-up)

## Files

### Modify
- `src/engine/events.ts` - Replace `ClarificationQuestion` interface (lines 18-24) and `ExpeditionModule` interface (lines 10-14) with `z.output<>` type aliases. Add imports from `schemas.ts`.
- `src/engine/agents/builder.ts` - Replace `EvaluationEvidence` interface (lines 66-77) and `EvaluationVerdict` interface (lines 82-90) with `z.output<>` type aliases imported from `schemas.ts`. Update `builderEvaluate()` to pass `evaluation_schema` to `loadPrompt()`.
- `src/engine/agents/common.ts` - Replace `StalenessVerdict` interface (lines 195-199) with `z.output<>` type alias from `schemas.ts`. Remove `VALID_STALENESS_VERDICTS` set (derive from schema or keep inline for parser). Update import.
- `src/engine/agents/plan-evaluator.ts` - Import `getEvaluationSchemaYaml` from `schemas.ts`, pass `evaluation_schema` to `loadPrompt()`
- `src/engine/agents/cohesion-evaluator.ts` - Import `getEvaluationSchemaYaml` from `schemas.ts`, pass `evaluation_schema` to `loadPrompt()`
- `src/engine/agents/planner.ts` - Import clarification, module, plan frontmatter schema getters from `schemas.ts`, pass `clarification_schema`, `module_schema`, `plan_frontmatter_schema` to `loadPrompt()` in `buildPrompt()`
- `src/engine/agents/staleness-assessor.ts` - Import `getStalenessSchemaYaml` from `schemas.ts`, pass `staleness_schema` to `loadPrompt()`
- `src/engine/prompts/evaluator.md` - Add `{{evaluation_schema}}` section near the Output section documenting verdict structure and evidence child elements
- `src/engine/prompts/plan-evaluator.md` - Add `{{evaluation_schema}}` section
- `src/engine/prompts/cohesion-evaluator.md` - Add `{{evaluation_schema}}` section
- `src/engine/prompts/planner.md` - Add `{{clarification_schema}}` near the Clarification Format section, `{{module_schema}}` near the modules section, `{{plan_frontmatter_schema}}` near the Plan File Format section
- `src/engine/prompts/staleness-assessor.md` - Add `{{staleness_schema}}` near the Output section
- `test/schemas.test.ts` - Add test cases for: evaluation schema YAML output, clarification schema YAML, staleness schema YAML, module schema YAML, plan frontmatter schema YAML, and safeParse for each

## Verification

- [ ] `EvaluationVerdict` and `EvaluationEvidence` in `builder.ts` are `z.output<>` type aliases, not interfaces
- [ ] `StalenessVerdict` in `common.ts` is a `z.output<>` type alias, not an interface
- [ ] `ClarificationQuestion` and `ExpeditionModule` in `events.ts` are `z.output<>` type aliases, not interfaces
- [ ] `evaluator.md`, `plan-evaluator.md`, `cohesion-evaluator.md` each contain `{{evaluation_schema}}`
- [ ] `planner.md` contains `{{clarification_schema}}`, `{{module_schema}}`, and `{{plan_frontmatter_schema}}`
- [ ] `staleness-assessor.md` contains `{{staleness_schema}}`
- [ ] `builderEvaluate()` passes `evaluation_schema` string to `loadPrompt()`
- [ ] `runPlanEvaluate()` and `runCohesionEvaluate()` pass `evaluation_schema` to `loadPrompt()`
- [ ] `buildPrompt()` in `planner.ts` passes `clarification_schema`, `module_schema`, `plan_frontmatter_schema` to `loadPrompt()`
- [ ] `runStalenessAssessor()` passes `staleness_schema` to `loadPrompt()`
- [ ] `test/schemas.test.ts` has passing tests for all remaining schema YAML outputs and safeParse cases
- [ ] `pnpm type-check` passes
- [ ] `pnpm test` passes
- [ ] `pnpm build` produces a clean build

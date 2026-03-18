---
id: plan-01-schemas-and-review-issue
name: Create schemas.ts and Apply ReviewIssue Schema
depends_on: []
branch: schema-driven-agent-prompts-zod-to-yaml-across-all-structured-blocks/schemas-and-review-issue
---

# Create schemas.ts and Apply ReviewIssue Schema

## Architecture Context

eforge agents emit structured XML blocks (review issues, evaluations, clarifications, etc.) that are parsed by regex-based parsers. The format instructions in prompts are hand-written and can drift from the parsers. The `getProfileSchemaYaml()` pattern in `config.ts` already solves this for profile generation - define Zod schemas with `.describe()`, convert to YAML via `z.toJSONSchema()`, inject into prompts. This plan creates the shared `schemas.ts` file and applies the pattern to `ReviewIssue` first since it touches the most prompts (7).

## Implementation

### Overview

Create `src/engine/schemas.ts` as a leaf-level file containing all Zod schemas and the shared `getSchemaYaml()` utility. Then apply the ReviewIssue schema to all 7 reviewer prompts and swap the hand-written `ReviewIssue` interface in `events.ts` with a `z.output<>` type alias. This plan defines ALL schemas upfront (not just ReviewIssue) so Plan 2 can use them without modifying `schemas.ts`.

### Key Decisions

1. **All schemas in one file** - `schemas.ts` contains every schema (ReviewIssue, EvaluationVerdict, Clarification, Staleness, Module, PlanFile frontmatter) even though this plan only wires ReviewIssue into prompts. This avoids Plan 2 needing to modify `schemas.ts`.
2. **Leaf-level file** - `schemas.ts` imports only `zod/v4` and `yaml`, no engine imports. Types flow outward from schemas, not inward.
3. **Per-perspective category enums** - Each reviewer perspective has its own category enum (general, code, security, api, docs, plan-review). The schema YAML injected into each prompt uses the perspective-specific categories.
4. **Schema YAML supplements XML examples** - The `{{review_issue_schema}}` variable injects schema YAML documentation alongside existing XML format examples in prompts. XML examples stay (show serialization format), schema YAML documents field semantics and allowed values.
5. **`getSchemaYaml()` caches per key** - Module-level `Map<string, string>` cache, matching the pattern in `getProfileSchemaYaml()`.

## Scope

### In Scope
- Create `src/engine/schemas.ts` with all Zod schemas, `getSchemaYaml()` utility, and convenience exports
- Define per-perspective category enum schemas for reviewers
- Replace `ReviewIssue` interface in `events.ts` with `z.output<typeof reviewIssueSchema>`
- Add `{{review_issue_schema}}` to all 7 reviewer prompts (reviewer.md, reviewer-code.md, reviewer-security.md, reviewer-api.md, reviewer-docs.md, plan-reviewer.md, cohesion-reviewer.md)
- Update `reviewer.ts` `composeReviewPrompt()` to pass schema YAML
- Update `parallel-reviewer.ts` to pass perspective-specific schema YAML per prompt
- Update `plan-reviewer.ts` and `cohesion-reviewer.ts` to pass plan-review schema YAML
- Create `test/schemas.test.ts` covering YAML output, caching, safeParse
- Update `SEVERITY_ORDER` in `events.ts` to use the schema-derived type

### Out of Scope
- Wiring EvaluationVerdict, Clarification, Staleness, Module, PlanFile schemas into prompts (Plan 2)
- Adding `safeParse()` validation to parsers (optional, deferred)

## Files

### Create
- `src/engine/schemas.ts` - All Zod schemas with `.describe()` annotations, `getSchemaYaml()` utility, per-perspective category enums, convenience exports
- `test/schemas.test.ts` - Tests for YAML generation, caching, safeParse validation

### Modify
- `src/engine/events.ts` - Replace `ReviewIssue` interface (lines 26-33) with `z.output<typeof reviewIssueSchema>` type alias. Import `reviewIssueSchema` from `schemas.ts`. Update `SEVERITY_ORDER` type annotation to use the derived type.
- `src/engine/prompts/reviewer.md` - Add `{{review_issue_schema}}` section before the Output Format section, documenting field semantics and allowed category values for the general perspective
- `src/engine/prompts/reviewer-code.md` - Add `{{review_issue_schema}}` with code-perspective categories
- `src/engine/prompts/reviewer-security.md` - Add `{{review_issue_schema}}` with security-perspective categories
- `src/engine/prompts/reviewer-api.md` - Add `{{review_issue_schema}}` with api-perspective categories
- `src/engine/prompts/reviewer-docs.md` - Add `{{review_issue_schema}}` with docs-perspective categories
- `src/engine/prompts/plan-reviewer.md` - Add `{{review_issue_schema}}` with plan-review categories
- `src/engine/prompts/cohesion-reviewer.md` - Add `{{review_issue_schema}}` with plan-review categories
- `src/engine/agents/reviewer.ts` - Import `getReviewIssueSchemaYaml` from `schemas.ts`, pass `review_issue_schema` variable to `loadPrompt()` in `composeReviewPrompt()`
- `src/engine/agents/parallel-reviewer.ts` - Import perspective-specific schema getters from `schemas.ts`, pass `review_issue_schema` per perspective prompt
- `src/engine/agents/plan-reviewer.ts` - Import and pass plan-review schema YAML to `loadPrompt()`
- `src/engine/agents/cohesion-reviewer.ts` - Import and pass plan-review schema YAML to `loadPrompt()`

## Verification

- [ ] `src/engine/schemas.ts` exists and imports only `zod/v4` and `yaml` (no engine imports)
- [ ] `schemas.ts` exports: `reviewIssueSchema`, `evaluationEvidenceSchema`, `evaluationVerdictSchema`, `clarificationQuestionSchema`, `stalenessVerdictSchema`, `expeditionModuleSchema`, `planFileFrontmatterSchema`, `getSchemaYaml()`, and per-perspective convenience getters
- [ ] `ReviewIssue` in `events.ts` is a `z.output<typeof reviewIssueSchema>` type alias, not an interface
- [ ] All 7 reviewer prompt `.md` files contain a `{{review_issue_schema}}` placeholder
- [ ] `composeReviewPrompt()` in `reviewer.ts` passes `review_issue_schema` to `loadPrompt()`
- [ ] `parallel-reviewer.ts` passes perspective-specific `review_issue_schema` per prompt
- [ ] `plan-reviewer.ts` and `cohesion-reviewer.ts` pass `review_issue_schema` to `loadPrompt()`
- [ ] `test/schemas.test.ts` has passing tests for: YAML output contains expected fields, caching returns same reference, valid ReviewIssue passes `safeParse`, invalid data fails `safeParse`
- [ ] `pnpm type-check` passes
- [ ] `pnpm test` passes

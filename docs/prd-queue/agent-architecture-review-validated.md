---
title: Agent Architecture Review (Validated)
created: 2026-03-19
status: pending
---

# Agent Architecture Consolidation

## Problem / Motivation

eforge has 15 agents organized across compile, build, post-merge, and queue phases. A validated architecture review identified two concrete consolidation opportunities:

1. **Plan Evaluator and Cohesion Evaluator are near-identical** - `plan-evaluator.ts` (71 lines) and `cohesion-evaluator.ts` (71 lines) are character-for-character identical except for options interface name, event type strings (`plan:evaluate:*` vs `plan:cohesion:evaluate:*`), prompt name, and agent role string. The prompts differ by ~5 lines across 162-line files (title/context paragraph, strict improvement examples, accept examples table, and one extra reject criterion for cohesion). This is ~70 lines of duplicate TypeScript and ~160 lines of duplicate prompt.

2. **`parseEvaluationBlock` lives in the wrong file** - `parseEvaluationBlock()`, `extractChildElement()`, `EvaluationVerdict`, and `EvaluationEvidence` live in `builder.ts` but are imported by `plan-evaluator.ts`, `cohesion-evaluator.ts`, and `test/xml-parsers.test.ts`. The natural home is `common.ts`, which already houses all provider-agnostic XML parsers (`parseClarificationBlocks`, `parseModulesBlock`, `parseProfileBlock`, `parseSkipBlock`, `parseStalenessBlock`, `parseGeneratedProfileBlock`).

The overall architecture is strong - the event-driven async generator pattern, backend abstraction, blind review principle, and pipeline composition are well-designed. These are surgical cleanups, not fundamental redesigns.

## Goal

Eliminate duplicated agent code by consolidating the plan evaluator and cohesion evaluator into a single parameterized runner, and relocate misplaced XML parsing utilities to their correct home - without changing any observable behavior, event types, or agent role strings.

## Approach

### R1: Consolidate Plan Evaluator + Cohesion Evaluator

Merge into a single parameterized runner function that accepts a `mode: 'plan' | 'cohesion'` parameter. The mode dispatches the correct event type strings, prompt name, and agent role string.

- **Keep both event types** (`plan:evaluate:*` and `plan:cohesion:evaluate:*`) - preserves all observability (tracing, CLI display, monitor UI)
- **Keep both agent role strings** in `AGENT_ROLES` for config flexibility
- **Unify the prompt** into one file with template variables for the ~5 lines of domain-specific differences (title, context paragraph, strict improvement bullet 1, accept examples table, reject criteria)
- **Delete** `cohesion-evaluator.ts` and `cohesion-evaluator.md`

Files that change (6):
- `src/engine/agents/plan-evaluator.ts` - parameterize with `mode`
- `src/engine/agents/cohesion-evaluator.ts` - delete
- `src/engine/prompts/plan-evaluator.md` - add template variables for domain differences
- `src/engine/prompts/cohesion-evaluator.md` - delete
- `src/engine/pipeline.ts` - update import and cohesion-review-cycle stage
- `src/engine/index.ts` - update barrel exports
- `test/agent-wiring.test.ts` - update import, both test suites preserved
- `test/cohesion-review.test.ts` - update import

Files that need zero changes (8): `src/engine/events.ts`, `src/engine/config.ts`, `src/cli/display.ts`, `src/monitor/mock-server.ts`, `src/monitor/ui/src/components/timeline/event-card.tsx`, `src/monitor/ui/src/components/pipeline/thread-pipeline.tsx` - because event types and roles are preserved.

**Note**: The build-phase evaluator (`builderEvaluate()` in `builder.ts`) must remain separate. It differs meaningfully with per-hunk evaluation, `{{strictness}}` injection, and code-level domain language. Different domain, different granularity.

### R2: Relocate `parseEvaluationBlock` to common.ts

Pure move refactoring. Move the parser function, types (`EvaluationVerdict`, `EvaluationEvidence`), and helper (`extractChildElement`) from `builder.ts` to `common.ts`.

Files that change (4):
- `src/engine/agents/builder.ts` - remove parser, import from `common.ts`
- `src/engine/agents/common.ts` - add parser + types + schemas import
- `src/engine/index.ts` - update barrel export source
- `test/xml-parsers.test.ts` - update import path

Zero behavioral change.

## Scope

### In scope

- Consolidating `plan-evaluator.ts` and `cohesion-evaluator.ts` into a single parameterized runner (R1)
- Unifying `plan-evaluator.md` and `cohesion-evaluator.md` into a single prompt with template variables (R1)
- Relocating `parseEvaluationBlock`, `extractChildElement`, `EvaluationVerdict`, and `EvaluationEvidence` from `builder.ts` to `common.ts` (R2)
- Updating imports in pipeline, barrel exports, and tests

### Out of scope

- **Planner size** - justified by scope (profile selection, clarification loops, plan writing are coupled)
- **Builder two-function design** - `builderImplement()` and `builderEvaluate()` are distinct tasks that share context, keep separate
- **Plan Reviewer vs Cohesion Reviewer separation** - different cognitive tasks despite structural similarity; cohesion reviewer has specialized domain knowledge (edit regions, file overlaps, integration contracts) and takes `architectureContent`
- **Build-phase evaluator consolidation** - `builderEvaluate()` differs meaningfully (per-hunk evaluation, `{{strictness}}` injection, code-level domain language)
- **Specialist reviewer separation** - correctly scoped with clean facade orchestration
- **Small utility agents** - all right-sized at 55-86 lines
- **Review cycle asymmetry** - intentional and correct (plan-reviewer writes fixes directly because plan issues are structural/unambiguous; code reviewer needs a separate fixer because code issues have multiple valid approaches)
- **Adding new reviewer perspectives** (test quality, performance, accessibility, database schema) - additive work (~150-200 lines of prompt + 2 Map entries + 1 schema getter each), defer until needed
- **Adding architecture reviewer for expeditions** - real gap (planner writes `architecture.md` with zero review before module-planning), but defer until expedition quality is a concrete concern; would require a new `architecture-review` compile stage between `planner` and `module-planning`
- **Agent runner boilerplate extraction** - defer until 20+ agents

## Acceptance Criteria

- `plan-evaluator.ts` accepts a `mode: 'plan' | 'cohesion'` parameter and dispatches the correct event type strings, prompt name, and agent role string based on mode
- `cohesion-evaluator.ts` is deleted
- `cohesion-evaluator.md` is deleted
- A single unified prompt file handles both plan and cohesion evaluation via template variables for the domain-specific differences (title, context paragraph, strict improvement bullet 1, accept examples table, reject criteria including cohesion's "module boundary change")
- Both event type families (`plan:evaluate:*` and `plan:cohesion:evaluate:*`) continue to emit correctly
- Both agent roles remain in `AGENT_ROLES` in `config.ts`
- The `cohesion-review-cycle` stage in `pipeline.ts` calls the consolidated runner with `mode: 'cohesion'`
- `parseEvaluationBlock()`, `extractChildElement()`, `EvaluationVerdict`, and `EvaluationEvidence` live in `src/engine/agents/common.ts`
- `builder.ts` imports these from `common.ts` instead of defining them locally
- Barrel exports in `src/engine/index.ts` are updated to reflect new source locations
- `pnpm type-check` passes
- `pnpm test` passes
- Both test suites (agent-wiring plan-evaluator tests + cohesion-review evaluator tests) still exercise their respective modes
- No changes to CLI display, monitor UI, or tracing behavior

---
id: plan-02-architecture-review-stage
name: Architecture Review Stage
depends_on: []
branch: r3-r4-test-reviewer-perspective-architecture-review-stage/architecture-review-stage
---

# Architecture Review Stage

## Architecture Context

The expedition compile pipeline currently runs `planner → module-planning → cohesion-review-cycle → compile-expedition`. The planner writes `architecture.md` but it goes unreviewed before module planners build against it. Flawed module boundaries or vague integration contracts propagate to all downstream plans.

This plan inserts an `architecture-review-cycle` stage between `planner` and `module-planning` using the existing `runReviewCycle()` helper from `pipeline.ts`. The architecture reviewer is a new one-shot agent that validates `architecture.md` against the PRD. The architecture evaluator reuses R1's consolidated evaluator by extending `EvaluatorMode` with a third `'architecture'` mode - no new evaluator file needed.

## Implementation

### Overview

Add four new event types, two new agent roles, a new compile stage, a new agent file, a new prompt, and a new evaluator mode. Wire the stage into the expedition profile and add rendering support in CLI and monitor UI.

### Key Decisions

1. Architecture evaluation reuses the consolidated `plan-evaluator.ts` by adding `mode: 'architecture'` to `EvaluatorMode`. This avoids creating a third near-identical evaluator file and validates the parameterized design from R1.
2. The `architecture-review-cycle` stage is non-fatal (try-catch with progress message on skip), matching the pattern used by `plan-review-cycle` and `cohesion-review-cycle`.
3. The stage only runs when `ctx.expeditionModules.length > 0`, same guard as `cohesion-review-cycle`.
4. Architecture review reuses `planReviewCategorySchema` categories (`cohesion`, `completeness`, `correctness`, `feasibility`, `dependency`, `scope`) since these apply equally to architecture documents.

## Scope

### In Scope
- Four new event types in `events.ts`
- Two new agent roles in `config.ts`
- Updated expedition profile compile stages
- `architecture-reviewer.ts` agent file
- `architecture-reviewer.md` prompt
- `'architecture'` mode in consolidated evaluator
- `'architecture-review-cycle'` compile stage in pipeline
- CLI display cases for new events
- Monitor UI agent mappings
- Barrel exports in `index.ts`
- Agent wiring tests

### Out of Scope
- Changes to `parseReviewIssues()` or `ReviewIssue` type (already generic)
- New evaluator file (reuses consolidated evaluator)
- R1/R2 work (assumed complete)

## Files

### Create
- `src/engine/agents/architecture-reviewer.ts` — `runArchitectureReview()` async generator. Options: `backend`, `sourceContent`, `planSetName`, `architectureContent`, `cwd`, `verbose`, `abortController`. Loads `architecture-reviewer` prompt with source, plan set name, architecture content, and schema. Runs one-shot with `tools: 'coding'`. Parses `<review-issues>` via `parseReviewIssues()`. Yields `plan:architecture:review:start` / `plan:architecture:review:complete`. Follows the exact pattern of `cohesion-reviewer.ts`.
- `src/engine/prompts/architecture-reviewer.md` — Architecture reviewer prompt. Role: architecture reviewer performing blind review of `architecture.md` against PRD. Focus areas: module boundary soundness, integration contract completeness, shared file registry clarity, data model feasibility, PRD alignment. Categories: reuse plan review categories via `getPlanReviewIssueSchemaYaml()`. Fix instructions: write fixes to `architecture.md` unstaged.

### Modify
- `src/engine/events.ts` — Add `AgentRole` entries: `'architecture-reviewer'`, `'architecture-evaluator'`. Add to `EforgeEvent` union: `{ type: 'plan:architecture:review:start' }`, `{ type: 'plan:architecture:review:complete'; issues: ReviewIssue[] }`, `{ type: 'plan:architecture:evaluate:start' }`, `{ type: 'plan:architecture:evaluate:complete'; accepted: number; rejected: number }`. Place these between the plan:evaluate and plan:cohesion event groups.
- `src/engine/config.ts` — Add `'architecture-reviewer'` and `'architecture-evaluator'` to `AGENT_ROLES` array. Update expedition profile `compile` array from `['planner', 'module-planning', 'cohesion-review-cycle', 'compile-expedition']` to `['planner', 'architecture-review-cycle', 'module-planning', 'cohesion-review-cycle', 'compile-expedition']`.
- `src/engine/agents/plan-evaluator.ts` — Extend `EvaluatorMode` to `'plan' | 'cohesion' | 'architecture'`. Add `architecture` entry to `MODE_CONFIG` with: `startEvent: 'plan:architecture:evaluate:start'`, `completeEvent: 'plan:architecture:evaluate:complete'`, `promptName: 'plan-evaluator'`, `role: 'architecture-evaluator'`, domain-specific `promptVars` (accept patterns for unclear module boundary clarified, missing integration contract added; reject patterns for changes to module decomposition strategy). Export `runArchitectureEvaluate()` wrapper function and `ArchitectureEvaluatorOptions` type.
- `src/engine/pipeline.ts` — Import `runArchitectureReview` from `./agents/architecture-reviewer.js` and `runArchitectureEvaluate` from `./agents/plan-evaluator.js`. Register `'architecture-review-cycle'` compile stage: guard on `ctx.expeditionModules.length === 0` (return early), read `architecture.md` from plan directory, call `runReviewCycle()` with reviewer = `runArchitectureReview(...)` and evaluator = `runArchitectureEvaluate(...)`, wrap in try-catch with progress message on failure.
- `src/engine/index.ts` — Add barrel exports: `runArchitectureReview` and `ArchitectureReviewerOptions` from `./agents/architecture-reviewer.js`, `runArchitectureEvaluate` and `ArchitectureEvaluatorOptions` from `./agents/plan-evaluator.js`.
- `src/cli/display.ts` — Add four cases for `plan:architecture:review:start` (spinner: "Reviewing architecture..."), `plan:architecture:review:complete` (issue summary), `plan:architecture:evaluate:start` (spinner: "Evaluating architecture review fixes..."), `plan:architecture:evaluate:complete` (accepted/rejected counts). Follow the exact cohesion review pattern.
- `src/monitor/ui/src/components/pipeline/thread-pipeline.tsx` — Add `'architecture-reviewer'` and `'architecture-evaluator'` to `REVIEW_AGENTS` set. Add both to `AGENT_COLORS` (reviewer: green, evaluator: purple - matching plan/cohesion pattern). Add both to `AGENT_TO_STAGE` mapping to `'architecture-review-cycle'`.
- `src/monitor/ui/src/components/timeline/event-card.tsx` — Add cases in `eventSummary()` for `plan:architecture:review:start` ("Architecture review started"), `plan:architecture:review:complete` ("Architecture review: N issue(s)"), `plan:architecture:evaluate:start` ("Evaluating architecture review fixes"), `plan:architecture:evaluate:complete` ("Accepted N, rejected N"). Add `plan:architecture:review:complete` to the detail rendering block alongside `plan:review:complete` and `build:review:complete`.
- `test/agent-wiring.test.ts` (or new `test/architecture-review.test.ts`) — Add wiring tests: `runArchitectureReview` emits `plan:architecture:review:start` and `plan:architecture:review:complete` with parsed issues from StubBackend XML output. Architecture evaluator mode (`runArchitectureEvaluate`) emits `plan:architecture:evaluate:start` and `plan:architecture:evaluate:complete` with correct accepted/rejected counts.

## Verification

- [ ] `pnpm type-check` exits with code 0
- [ ] `pnpm test` exits with code 0
- [ ] `EvaluatorMode` type includes `'architecture'`
- [ ] `MODE_CONFIG['architecture']` has `startEvent: 'plan:architecture:evaluate:start'` and `completeEvent: 'plan:architecture:evaluate:complete'`
- [ ] `AGENT_ROLES` array in config.ts includes `'architecture-reviewer'` and `'architecture-evaluator'`
- [ ] Expedition profile compile stages are `['planner', 'architecture-review-cycle', 'module-planning', 'cohesion-review-cycle', 'compile-expedition']`
- [ ] `architecture-review-cycle` stage is registered in the compile stage registry (`getCompileStageNames()` includes it)
- [ ] `runArchitectureReview()` yields `plan:architecture:review:start` as first event and `plan:architecture:review:complete` with `issues` array as last domain event
- [ ] `runArchitectureEvaluate()` yields `plan:architecture:evaluate:start` as first event and `plan:architecture:evaluate:complete` with `accepted`/`rejected` counts as last domain event
- [ ] `architecture-reviewer.md` prompt exists and contains module boundary, integration contract, and shared file registry focus areas
- [ ] CLI display handles all four `plan:architecture:*` event types without falling to default case
- [ ] Monitor `REVIEW_AGENTS` set contains `'architecture-reviewer'` and `'architecture-evaluator'`
- [ ] Monitor `AGENT_TO_STAGE` maps both roles to `'architecture-review-cycle'`

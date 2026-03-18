---
id: plan-01-fix-scope-and-delete-assessor
name: Fix Planner Scope Assessment and Delete Unused Assessor Agent
depends_on: []
branch: fix-planner-scope-assessment-delete-unused-assessor-agent/fix-scope-and-delete-assessor
---

# Fix Planner Scope Assessment and Delete Unused Assessor Agent

## Architecture Context

The planner agent (`src/engine/agents/planner.ts`) handles scope assessment, profile selection, and plan generation in a single pass. A separate assessor agent (`src/engine/agents/assessor.ts`) exists but is never called from any pipeline stage - it is dead code. The planner's scope assessment currently over-indexes on dependency structure, classifying high-volume mechanical refactors as errands even when they touch 20+ files and exceed builder capacity (~30 turns).

## Implementation

### Overview

Two changes in one atomic plan:

1. Rewrite the planner prompt's scope assessment section to weigh multiple dimensions (dependency structure, execution volume, independence, risk surface) instead of dependency structure alone.
2. Delete the assessor agent and all references to it across the codebase.

### Key Decisions

1. The scope level table removes "This is the default" from errand to prevent the planner from defaulting to errand regardless of volume indicators.
2. The new multi-dimensional guidance adds execution volume as a first-class signal with concrete file count thresholds, and adds an explicit instruction to trust codebase exploration over source document labels.
3. The splitting guidance adds volume as a valid reason to split ("total execution volume would strain a single builder session"), while keeping the existing anti-split rules.
4. The `'staleness-assessor'` agent role is preserved throughout - only `'assessor'` references are removed.
5. The monitor UI's `AGENT_COLORS` map has an `assessor` entry that must also be removed.

## Scope

### In Scope
- Rewriting the planner prompt's scope assessment guidance (lines 79-106 of `planner.md`)
- Deleting `src/engine/agents/assessor.ts`, `src/engine/prompts/assessor.md`, `test/assessor-wiring.test.ts`
- Removing `'assessor'` from `AgentRole` union in `events.ts`
- Removing `assessor: 20` from `AGENT_MAX_TURNS_DEFAULTS` in `pipeline.ts`
- Removing `'assessor'` from `AGENT_ROLES` array in `config.ts`
- Removing `import { runAssessor }` from `test/agent-wiring.test.ts`
- Removing the `runAssessor` test block from `test/agent-wiring.test.ts`
- Removing `assessor` entry from `AGENT_COLORS` in the monitor UI
- Updating CLAUDE.md agent list and count

### Out of Scope
- Changes to the `staleness-assessor` agent
- Changes to planner logic outside scope assessment
- Any other agent modifications
- Changes to the assessor prompt content in the planner prompt (the planner already has its own scope assessment - we're improving it, not merging the assessor's)

## Files

### Delete
- `src/engine/agents/assessor.ts` — unused assessor agent implementation
- `src/engine/prompts/assessor.md` — unused assessor prompt
- `test/assessor-wiring.test.ts` — tests for the unused assessor agent

### Modify
- `src/engine/prompts/planner.md` — replace the scope level table (lines 79-84), the concrete indicators block (lines 86-93), and the splitting guidance (lines 97-106) with multi-dimensional scope assessment guidance; add independent assessment instruction after splitting guidance
- `src/engine/events.ts` — remove `'assessor'` from the `AgentRole` union type (line 10)
- `src/engine/pipeline.ts` — remove `assessor: 20` from `AGENT_MAX_TURNS_DEFAULTS` (line 219)
- `src/engine/config.ts` — remove `'assessor'` from the `AGENT_ROLES` array (line 17)
- `test/agent-wiring.test.ts` — remove `import { runAssessor }` (line 9) and remove the `runAssessor profile emission` describe block (lines 336-376)
- `src/monitor/ui/src/components/pipeline/thread-pipeline.tsx` — remove the `assessor` entry from `AGENT_COLORS` (line 16)
- `CLAUDE.md` — remove the Assessor bullet from the agent list, update agent count from 16 to 15

## Verification

- [ ] `pnpm type-check` exits with code 0
- [ ] `pnpm test` exits with code 0
- [ ] `grep -r "assessor" src/ test/ CLAUDE.md --include='*.ts' --include='*.md' --include='*.tsx' | grep -v staleness-assessor | grep -v planner-scope-assessment` returns no matches (no stale assessor references remain)
- [ ] The planner prompt (`src/engine/prompts/planner.md`) contains a "Weigh these dimensions together" section with dependency structure, execution volume, independence, and risk surface
- [ ] The planner prompt contains a file count indicator table with errand (1-5), excursion (5-15), expedition (15+) thresholds
- [ ] The planner prompt contains "Assess scope based on your own codebase exploration, not on labels or scope claims in the source document"
- [ ] `src/engine/agents/assessor.ts` does not exist
- [ ] `src/engine/prompts/assessor.md` does not exist
- [ ] `test/assessor-wiring.test.ts` does not exist
- [ ] The `AgentRole` type in `events.ts` does not include `'assessor'` (but does include `'staleness-assessor'`)
- [ ] The `AGENT_ROLES` array in `config.ts` does not include `'assessor'` (but does include `'staleness-assessor'`)
- [ ] The `AGENT_MAX_TURNS_DEFAULTS` in `pipeline.ts` does not include `assessor`
- [ ] CLAUDE.md agent list does not mention "Assessor" (but does mention "Staleness Assessor") and says "15 agents"

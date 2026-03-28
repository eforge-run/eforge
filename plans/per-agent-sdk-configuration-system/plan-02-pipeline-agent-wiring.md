---
id: plan-02-pipeline-agent-wiring
name: Pipeline and Agent File Wiring
depends_on: [plan-01-types-config-backend]
branch: per-agent-sdk-configuration-system/pipeline-agent-wiring
---

# Pipeline and Agent File Wiring

## Architecture Context

Plan 01 established `SdkPassthroughConfig`, `pickSdkOptions()`, and `ResolvedAgentConfig` types, rewrote `resolveAgentConfig()` to return full SDK config, and mapped fields through the SDK backend. This plan completes the wiring by threading resolved config through all pipeline call sites and updating all agent Options interfaces and `backend.run()` calls.

Since all new SDK passthrough fields are optional, each agent file change is backward-compatible - existing callers that don't pass the new fields continue to work identically.

## Implementation

### Overview

Two mechanical changes repeated across the codebase:

1. **Pipeline stages** (9 call sites in `pipeline.ts`): Each stage already calls `resolveAgentConfig()` and destructures `maxTurns`. Expand to spread the full `ResolvedAgentConfig` into agent options using `...agentConfig` instead of just `maxTurns: agentConfig.maxTurns`.

2. **Agent files** (15 files, ~18 Options interfaces): Each agent's Options interface extends `SdkPassthroughConfig`. Each `backend.run()` call includes `...pickSdkOptions(options)` to forward any SDK config that was threaded through.

### Key Decisions

1. **Spread entire `agentConfig` into agent calls** - Rather than picking individual fields, spread the full resolved config. This future-proofs against new fields being added to `ResolvedAgentConfig` without touching every pipeline call site again.
2. **Agent Options extend `SdkPassthroughConfig`** - Each agent's Options interface gains the SDK fields via interface extension. No runtime behavior change since all fields are optional.
3. **`pickSdkOptions()` in `backend.run()` calls** - Each agent's `backend.run()` call adds `...pickSdkOptions(options)` to the options object. This strips `undefined` fields and forwards only explicitly-set SDK config.
4. **Agents with hardcoded `maxTurns`** - Some agents (reviewer: 30, staleness-assessor: 20, formatter: 1) have hardcoded `maxTurns` in their `backend.run()` calls rather than accepting it from options. These stay hardcoded but gain the SDK passthrough spread. The `maxTurns` from pipeline still flows in via options for agents that accept it (builder, planner, module-planner, doc-updater, test-writer, tester).

## Scope

### In Scope
- Update 12 pipeline call sites in `pipeline.ts` to spread full `ResolvedAgentConfig` (7 existing build-stage sites + 2 new build-stage sites for reviewer/review-fixer + 3 new compile-stage sites)
- Update 16 agent files: Options interfaces extend `SdkPassthroughConfig`, `backend.run()` calls spread `pickSdkOptions(options)`
- Import `SdkPassthroughConfig` and `pickSdkOptions` from `backend.ts` in each agent file

### Out of Scope
- Changing default SDK values for any role (all remain `undefined`)
- Modifying agent behavior or prompts
- Adding role-specific built-in defaults beyond existing `maxTurns` entries

## Files

### Modify
- `src/engine/pipeline.ts` - Update 9 call sites where `resolveAgentConfig()` result is threaded to agents:
  1. `plannerStage` (line ~443): spread `agentConfig` into `runPlanner()` options
  2. `modulePlanningStage` (line ~685): spread `agentConfig` into `runModulePlanner()` options
  3. `implementStage` (line ~856): spread `agentConfig` into `builderImplement()` options
  4. `evaluateStage` (line ~1048): spread `evalAgentConfig` into `builderEvaluate()` options
  5. `docUpdateStage` (line ~1112): spread `agentConfig` into `runDocUpdater()` options
  6. `testWriteStage` (line ~1159): spread `agentConfig` into `runTestWriter()` options
  7. `testStageInner` (line ~1194): spread `agentConfig` into `runTester()` options
  8. `reviewStage` (line ~958): resolve config for `reviewer` role and spread into `runParallelReview()` options
  9. `reviewFixStage` (line ~1007): resolve config for `review-fixer` role and spread into `runReviewFixer()` options
  Additionally, add `resolveAgentConfig` calls for compile-stage agents that currently don't use it:
  10. `planReviewCycleStage` (line ~544): resolve for `plan-reviewer` and `plan-evaluator`, spread into calls
  11. `architectureReviewCycleStage` (line ~600): resolve for `architecture-reviewer` and `architecture-evaluator`, spread into calls
  12. `cohesionReviewCycleStage` (line ~753): resolve for `cohesion-reviewer` and `cohesion-evaluator`, spread into calls

- `src/engine/agents/builder.ts` - `BuilderOptions` extends `SdkPassthroughConfig`. Both `backend.run()` calls (implement + evaluate) add `...pickSdkOptions(options)`.
- `src/engine/agents/planner.ts` - `PlannerOptions` extends `SdkPassthroughConfig`. `backend.run()` call adds `...pickSdkOptions(options)`.
- `src/engine/agents/reviewer.ts` - `ReviewerOptions` extends `SdkPassthroughConfig`. `backend.run()` call adds `...pickSdkOptions(options)`.
- `src/engine/agents/parallel-reviewer.ts` - `ParallelReviewerOptions` extends `SdkPassthroughConfig`. `backend.run()` call adds `...pickSdkOptions(options)`.
- `src/engine/agents/plan-reviewer.ts` - `PlanReviewerOptions` extends `SdkPassthroughConfig`. `backend.run()` call adds `...pickSdkOptions(options)`.
- `src/engine/agents/plan-evaluator.ts` - `PlanPhaseEvaluatorOptions` and `PlanEvaluatorOptions` extend `SdkPassthroughConfig`. `backend.run()` call adds `...pickSdkOptions(options)`.
- `src/engine/agents/architecture-reviewer.ts` - `ArchitectureReviewerOptions` extends `SdkPassthroughConfig`. `backend.run()` call adds `...pickSdkOptions(options)`.
- `src/engine/agents/cohesion-reviewer.ts` - `CohesionReviewerOptions` extends `SdkPassthroughConfig`. `backend.run()` call adds `...pickSdkOptions(options)`.
- `src/engine/agents/review-fixer.ts` - `ReviewFixerOptions` extends `SdkPassthroughConfig`. `backend.run()` call adds `...pickSdkOptions(options)`.
- `src/engine/agents/validation-fixer.ts` - `ValidationFixerOptions` extends `SdkPassthroughConfig`. `backend.run()` call adds `...pickSdkOptions(options)`.
- `src/engine/agents/merge-conflict-resolver.ts` - `MergeConflictResolverOptions` extends `SdkPassthroughConfig`. `backend.run()` call adds `...pickSdkOptions(options)`.
- `src/engine/agents/staleness-assessor.ts` - `StalenessAssessorOptions` extends `SdkPassthroughConfig`. `backend.run()` call adds `...pickSdkOptions(options)`.
- `src/engine/agents/formatter.ts` - `FormatterOptions` extends `SdkPassthroughConfig`. `backend.run()` call adds `...pickSdkOptions(options)`.
- `src/engine/agents/doc-updater.ts` - `DocUpdaterOptions` extends `SdkPassthroughConfig`. `backend.run()` call adds `...pickSdkOptions(options)`.
- `src/engine/agents/tester.ts` - `TestWriterOptions` and `TesterOptions` extend `SdkPassthroughConfig`. Both `backend.run()` calls add `...pickSdkOptions(options)`.
- `src/engine/agents/module-planner.ts` - `ModulePlannerOptions` extends `SdkPassthroughConfig`. `backend.run()` call adds `...pickSdkOptions(options)`.

## Verification

- [ ] `pnpm type-check` passes with zero errors
- [ ] `pnpm test` passes - all existing tests continue to pass with no behavior change
- [ ] Every `backend.run()` call across all 16 agent files includes `...pickSdkOptions(options)` (verify with grep: `grep -r 'pickSdkOptions' src/engine/agents/` returns 18+ matches for 16 files)
- [ ] Every agent Options interface extends `SdkPassthroughConfig` (verify with grep: `grep -r 'extends.*SdkPassthroughConfig' src/engine/agents/` returns 18+ matches)
- [ ] All 12 pipeline call sites spread resolved config into agent calls (verify with grep for `...agentConfig` or `...evalAgentConfig` patterns in pipeline.ts)
- [ ] Compile-stage agents (plan-reviewer, plan-evaluator, architecture-reviewer, cohesion-reviewer) now receive resolved config from pipeline
- [ ] Setting `agents.roles.formatter.effort: low` in eforge.yaml results in the formatter agent's `backend.run()` call receiving `effort: 'low'` in its options (verifiable via Langfuse trace or verbose output)
- [ ] Setting `agents.model: claude-haiku-4-5-20251001` in eforge.yaml results in all agents receiving that model unless overridden per-role

---
id: plan-01-pipeline-refactor
name: Decompose pipeline.ts into pipeline/ directory
depends_on: []
branch: hardening-12-pipeline-ts-refactor-and-eforge-build-client-boundary-decision/pipeline-refactor
agents:
  builder:
    effort: xhigh
    rationale: "Mechanical but very large refactor: 2,080-line file decomposed into
      ~6 new files with strict no-behavior-change guarantee. Builder must
      preserve every export, function signature, registration call, and event
      order while moving code across files."
  reviewer:
    effort: high
    rationale: Must verify zero behavior change across stage generators, register*
      call ordering, and re-export surface. Subtle reordering or dropped event
      yields would silently break the engine.
---

# Decompose pipeline.ts into pipeline/ directory

## Architecture Context

`packages/engine/src/pipeline.ts` is a 2,080-line module that owns:

- The compile/build stage registry (`registerCompileStage`, `registerBuildStage`, `getCompileStage`, etc.) and the `validatePipeline` function.
- The `resolveAgentConfig` resolver plus all the model/role default tables (`AGENT_ROLE_DEFAULTS`, `AGENT_MODEL_CLASSES`, `MODEL_CLASS_DEFAULTS`, `MODEL_CLASS_TIER`, `AGENT_MAX_CONTINUATIONS_DEFAULTS`).
- Every built-in compile stage (planner, plan-review-cycle, architecture-review-cycle, module-planning, cohesion-review-cycle, compile-expedition).
- Every built-in build stage (implement, review, evaluate, review-fix, review-cycle, validate, doc-update, test-write, test, test-cycle).
- The shared `runReviewCycle` helper, `runCompilePipeline` and `runBuildPipeline` runners, plus various small utilities (`createToolTracker`, `populateSpan`, `hasUnstagedChanges`, `captureFileDiffs`, `withPeriodicFileCheck`, `emitFilesChanged`, `commitPlanArtifacts`, `humanizeName`, `arraysEqual`, `hasTestStages`, `buildContinuationDiff`, `formatStageRegistry`, `extractPrdMetadata`, `filterIssuesBySeverity`, `backfillDependsOn`).

After the unified retry policy work in `packages/engine/src/retry.ts`, retry/continuation logic is no longer interleaved into stage bodies — the remaining concentration is in stage context wiring, span/tracker bookkeeping, git ops (`emitFilesChanged`, post-parallel commits, `commitPlanArtifacts`), and config resolution. This plan factors those into a `pipeline/` directory of single-responsibility modules.

Consumers import every public symbol from `./pipeline.js` (engine-internal) or `@eforge-build/engine` (root barrel re-export). The refactor must preserve every named export at the original import paths.

## Implementation

### Overview

Convert `packages/engine/src/pipeline.ts` into a `packages/engine/src/pipeline/` directory and split the contents by concern. Keep `packages/engine/src/pipeline.ts` as a thin barrel that re-exports the same names so external import paths remain stable. Stage generators read top-to-bottom by delegating to extracted context-builder, span-wiring, git-ops, and error-translator helpers.

### Key Decisions

1. **Directory layout, not single file.** The PRD invites either a directory split or a slimmer single file. Given six compile stages, ten build stages, ~20 helpers, and the registry/resolver, a directory is clearer. Each file stays well under 500 lines.
2. **Preserve the `pipeline.ts` import path via a barrel.** Many consumers (`agents/`, `eforge.ts`, `orchestrator.ts`, `compiler.ts`, root `index.ts`, tests) import directly from `./pipeline.js`. Keep `packages/engine/src/pipeline.ts` as a thin re-export barrel (`export * from './pipeline/index.js';`) so external import paths remain stable without touching downstream files. (Node's ESM resolver does not do directory indexing for explicit `.js` paths, so `pipeline.ts` must continue to exist as a file; we cannot rely on `./pipeline.js` resolving to `./pipeline/index.js` implicitly.)
3. **No behavior change.** Event ordering, span lifecycle (per-attempt creation in retry wrappers), `register*` invocation order, and side effects must be byte-identical. Tests catch regressions: `test/pipeline.test.ts`, `test/agent-wiring.test.ts`, `test/continuation.test.ts`, `test/evaluator-continuation.test.ts`, `test/lane-awareness.test.ts`.
4. **Extract one error translator.** The repeated `err instanceof AgentTerminalError ? err.subtype : undefined` pattern (plus the `build:failed` event shape it feeds) becomes a single helper with one focused test. Currently used in `implementStage` (line ~1470). Co-locate it with any other per-stage error→event mapping discovered while moving stage bodies.
5. **Split `resolveAgentConfig` and `validatePipeline` by concern.** Each currently exceeds the ~50-line target named in the acceptance criteria. Split as documented under Files → Create.
6. **Keep stage context inline-able.** "Stage context builder" for these stages is mostly `resolveAgentConfig(role, ctx.config, ctx.config.backend, ctx.planEntry)` plus span/tracker creation. Extract a tiny `createStageSpanWiring(role, ctx, metadata)` helper that returns `{ span, tracker, end, error }` — every stage body collapses to: resolve config → build span wiring → run agent (optionally via `withRetry`) → handle result.

### Refactor Strategy

Move code in this order to keep diffs reviewable and tests green at each step:

1. Create `pipeline/types.ts` with `PipelineContext`, `BuildStageContext`, `CompileStage`, `BuildStage`, `StagePhase`, `StageDescriptor`. Re-export from new `pipeline/index.ts`.
2. Create `pipeline/registry.ts` with the `compileStages`/`buildStages` maps, `register*`/`get*`/`getCompileStageNames`/`getBuildStageNames`/`getCompileStageDescriptors`/`getBuildStageDescriptors`/`formatStageRegistry`.
3. Create `pipeline/validate.ts` with `validatePipeline` split into: `checkStageExistence`, `checkPredecessorOrdering`, `checkConflicts`, `checkParallelizability`. Public `validatePipeline` orchestrates them and aggregates `{ errors, warnings }`.
4. Create `pipeline/agent-config.ts` with the role/model tables (`AGENT_ROLE_DEFAULTS`, `AGENT_MAX_CONTINUATIONS_DEFAULTS`, `AGENT_MODEL_CLASSES`, `MODEL_CLASS_DEFAULTS`, `MODEL_CLASS_TIER`) plus `resolveAgentConfig` split into: `resolveSdkPassthrough` (loops over `SDK_FIELDS`, returns `{ values, effortSource, thinkingSource }`), `resolveModel` (per-role/global/class tier/fallback chain), `applyEffortClamp`, `applyThinkingCoercion`. Public `resolveAgentConfig` composes them.
5. Create `pipeline/git-helpers.ts` with `hasUnstagedChanges`, `captureFileDiffs` (already exported), `arraysEqual`, `withPeriodicFileCheck`, `emitFilesChanged`, `buildContinuationDiff`, `commitPlanArtifacts`, and the `FILE_CHECK_INTERVAL_MS` constant. These are the diff capture / status check / inline `exec('git', …)` operations the PRD targets.
6. Create `pipeline/error-translator.ts` exporting `toBuildFailedEvent(planId: string, err: unknown): EforgeEvent` (and any sibling translators discovered while moving stage bodies). Centralizes `AgentTerminalError → terminalSubtype` extraction.
7. Create `pipeline/span-wiring.ts` exporting `createStageSpanWiring(role, ctx, metadata)` which encapsulates `tracing.createSpan` + `setInput` + `createToolTracker` + cleanup-on-throw. Also re-export `createToolTracker` and `populateSpan` from here (or a sibling `pipeline/tracing.ts` if cleaner).
8. Create `pipeline/stages/compile-stages.ts` with the six compile stages and their `runReviewCycle`-using bodies.
9. Create `pipeline/stages/build-stages.ts` with the ten build stages plus the `runReviewCycle` helper, `ReviewCycleConfig`, `hasTestStages`, `testIssueToReviewIssue` usage.
10. Create `pipeline/runners.ts` with `runCompilePipeline` and `runBuildPipeline`.
11. Create `pipeline/misc.ts` (or fold into `agent-config.ts` / `validate.ts` as appropriate) with `humanizeName`, `extractPrdMetadata`, `filterIssuesBySeverity`, `backfillDependsOn` — these don't fit elsewhere cleanly.
12. Create `pipeline/index.ts` as the barrel re-exporting every previously-public symbol from the modules above.
13. Replace the contents of `packages/engine/src/pipeline.ts` with a thin re-export barrel (`export * from './pipeline/index.js';`) so every existing `import … from './pipeline.js'` (or `'../pipeline.js'`) continues to resolve under Node ESM. Do not delete the file.
14. Add `test/pipeline-error-translator.test.ts` covering `toBuildFailedEvent`: AgentTerminalError with each subtype, plain Error, non-Error throw value.

### Verification of "no behavior change"

- Stage registration order: register calls run as a side effect of importing the stages files. `pipeline/index.ts` must import `./stages/compile-stages.js` and `./stages/build-stages.js` in the same relative order they appear today (compile first, then build). Document this with a comment in `pipeline/index.ts`.
- Event yield ordering inside each stage must be preserved verbatim. Each moved stage body is a mechanical copy.
- `withPeriodicFileCheck`, `emitFilesChanged`, and `commitPlanArtifacts` keep identical behavior — they move files but their bodies are unchanged.

## Scope

### In Scope
- Split `packages/engine/src/pipeline.ts` into the `packages/engine/src/pipeline/` directory described above
- Split `resolveAgentConfig` and `validatePipeline` into named sub-functions, each under ~50 lines
- Extract a `toBuildFailedEvent` (or equivalently named) error-translator helper, used everywhere `AgentTerminalError → build:failed` mapping appears, with a focused test
- Extract `createStageSpanWiring` so each stage body reads as build context → invoke agent → handle result
- Move post-stage git ops (`emitFilesChanged`, `captureFileDiffs`, `hasUnstagedChanges`, status checks, `commitPlanArtifacts`) into `pipeline/git-helpers.ts`
- Update internal-only imports inside the engine package only if the move requires it; external import paths (e.g. `from './pipeline.js'`) remain valid via the barrel
- Add `test/pipeline-error-translator.test.ts`

### Out of Scope
- Any change to stage semantics, event ordering, retry behavior, or the public API surface
- Touching `packages/engine/src/agents/`, `backends/`, `orchestrator/` or any other directory beyond what's required to keep imports resolving
- The `@eforge-build/client` boundary work (covered by plan-02)
- Renaming exported symbols
- Splitting backends, monitor server, or other long files

## Files

### Create
- `packages/engine/src/pipeline/index.ts` — barrel re-exporting every public symbol previously exported from `pipeline.ts`; imports `./stages/compile-stages.js` and `./stages/build-stages.js` for their `register*` side effects in the same order as today
- `packages/engine/src/pipeline/types.ts` — `PipelineContext`, `BuildStageContext`, `CompileStage`, `BuildStage`, `StagePhase`, `StageDescriptor`
- `packages/engine/src/pipeline/registry.ts` — stage maps, `register*`, `get*`, `getCompileStageNames`, `getBuildStageNames`, `getCompileStageDescriptors`, `getBuildStageDescriptors`, `formatStageRegistry`
- `packages/engine/src/pipeline/validate.ts` — `validatePipeline` plus `checkStageExistence`, `checkPredecessorOrdering`, `checkConflicts`, `checkParallelizability` (each under ~50 lines)
- `packages/engine/src/pipeline/agent-config.ts` — `AGENT_ROLE_DEFAULTS`, `AGENT_MAX_CONTINUATIONS_DEFAULTS`, `AGENT_MODEL_CLASSES`, `MODEL_CLASS_DEFAULTS`, `MODEL_CLASS_TIER`, plus `resolveAgentConfig` split into `resolveSdkPassthrough`, `resolveModel`, `applyEffortClamp`, `applyThinkingCoercion` (each under ~50 lines)
- `packages/engine/src/pipeline/git-helpers.ts` — `hasUnstagedChanges`, `captureFileDiffs`, `arraysEqual`, `withPeriodicFileCheck`, `emitFilesChanged`, `buildContinuationDiff`, `commitPlanArtifacts`, `FILE_CHECK_INTERVAL_MS`
- `packages/engine/src/pipeline/error-translator.ts` — `toBuildFailedEvent(planId, err)` and any sibling translators surfaced during the move
- `packages/engine/src/pipeline/span-wiring.ts` — `createStageSpanWiring(role, ctx, metadata)` plus `createToolTracker` and `populateSpan`
- `packages/engine/src/pipeline/stages/compile-stages.ts` — the six compile stages (planner, plan-review-cycle, architecture-review-cycle, module-planning, cohesion-review-cycle, compile-expedition)
- `packages/engine/src/pipeline/stages/build-stages.ts` — the ten build stages plus `runReviewCycle` and `ReviewCycleConfig` and `hasTestStages`
- `packages/engine/src/pipeline/runners.ts` — `runCompilePipeline`, `runBuildPipeline`
- `packages/engine/src/pipeline/misc.ts` — `humanizeName`, `extractPrdMetadata`, `filterIssuesBySeverity`, `backfillDependsOn` (or fold into a more specific module if a clear home exists)
- `test/pipeline-error-translator.test.ts` — focused test covering AgentTerminalError mapping, plain Error fallback, and non-Error throws

### Modify
- `packages/engine/src/pipeline.ts` — replace contents with a thin re-export barrel: `export * from './pipeline/index.js';`. The file must continue to exist because Node ESM does not resolve `./pipeline.js` to `./pipeline/index.js` implicitly; keeping the one-line file lets every existing `import … from './pipeline.js'` continue to work without touching consumers
- Any internal engine file whose import broke during the move (most should not need changes since they import from `./pipeline.js`); only touch what type-check forces

## Verification

- [ ] `pnpm type-check` passes from the repo root
- [ ] `pnpm test` passes — including the existing `test/pipeline.test.ts`, `test/pipeline-composer.test.ts`, `test/agent-wiring.test.ts`, `test/continuation.test.ts`, `test/evaluator-continuation.test.ts`, `test/lane-awareness.test.ts`
- [ ] `pnpm build` succeeds and emits `packages/eforge/dist/cli.js`
- [ ] `packages/engine/src/pipeline.ts` contains only a single re-export line (`export * from './pipeline/index.js';`) and `packages/engine/src/pipeline/` contains the new modules
- [ ] `wc -l` on every new file in `packages/engine/src/pipeline/` returns under 500 lines
- [ ] No stage generator function (`plannerStage`, `reviewStage`, `evaluateStage`, `reviewFixStage`, `reviewCycleStage`, `implementStage`, `docUpdateStage`, `testWriteStage`, `testStage`, `testCycleStage`, `validateStage`, `planReviewCycleStage`, `architectureReviewCycleStage`, `modulePlanningStage`, `cohesionReviewCycleStage`, `compileExpeditionStage`) exceeds 80 lines counted from `function*` body open to close brace
- [ ] `resolveAgentConfig` body is under 50 lines and delegates to named sub-functions; each sub-function (`resolveSdkPassthrough`, `resolveModel`, `applyEffortClamp`, `applyThinkingCoercion`) is under 50 lines
- [ ] `validatePipeline` body is under 50 lines and delegates to named sub-functions; each sub-function (`checkStageExistence`, `checkPredecessorOrdering`, `checkConflicts`, `checkParallelizability`) is under 50 lines
- [ ] `packages/engine/src/pipeline/git-helpers.ts` exists and contains `emitFilesChanged`, `captureFileDiffs`, `hasUnstagedChanges`, `commitPlanArtifacts`
- [ ] A single `toBuildFailedEvent` (or equivalently named) helper exists in `packages/engine/src/pipeline/error-translator.ts` and is the only place where `err instanceof AgentTerminalError ? err.subtype : undefined` appears in pipeline code
- [ ] `test/pipeline-error-translator.test.ts` exists and asserts: AgentTerminalError input produces an event with the matching `terminalSubtype`; plain Error input produces an event without `terminalSubtype`; non-Error throw value produces an event with stringified message
- [ ] Running `pnpm build` from the repo root produces a `packages/eforge/dist/cli.js` whose stage registration output (printed via `formatStageRegistry()`) matches the pre-refactor table row-for-row

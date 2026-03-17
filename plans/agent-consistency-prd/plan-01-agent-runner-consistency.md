---
id: plan-01-agent-runner-consistency
name: Agent Runner Consistency Refactor
depends_on: []
branch: agent-consistency-prd/agent-runner-consistency
---

# Agent Runner Consistency Refactor

## Architecture Context

All 12+ agent runners in `src/engine/agents/` share a common interaction pattern with the `AgentBackend` interface: iterate `backend.run()`, filter events via `isAlwaysYieldedAgentEvent()`, accumulate `agent:message` text, parse structured output, yield domain events. This pattern is repeated inline in every agent with subtle inconsistencies in error handling, verbose filtering, and text accumulation. The planner additionally embeds a ~90-line clarification loop that no other agent can reuse.

This plan standardizes all three concerns in a single pass: extract shared helpers, fix error handling to follow the builder's event-then-return pattern, and make the clarification loop reusable.

## Implementation

### Overview

Four coordinated changes, applied bottom-up:

1. **`collectAgentOutput` helper** in `common.ts` - extracts the backend.run() iteration loop that every agent repeats
2. **Unified error handling** - applied as agents are refactored to use `collectAgentOutput`. Standardize on: yield completion event with error context, return cleanly. Reserve throws for `AbortError` only.
3. **`withClarification` middleware** in `common.ts` - extracts the planner's multi-turn clarification loop into a reusable wrapper
4. **Pipeline data-flow documentation** + `buildFailed` refactor in `pipeline.ts`

### Key Decisions

1. **`collectAgentOutput` returns accumulated text via the generator's return value.** Callers use `yield*` delegation via a `yieldAndCollect` convenience wrapper: `const text = yield* yieldAndCollect(collectAgentOutput(events, opts));`. This avoids callbacks and keeps the event stream intact in a one-liner at each call site.

2. **Error handling standardization uses the builder pattern universally.** On non-abort error: yield the agent's completion event (with zero counts or error context), then return. On abort: re-throw. This means `plan-evaluator` and `cohesion-evaluator` stop re-throwing after yielding, and `validation-fixer`/`review-fixer` gain explicit error context in their completion events (they already return cleanly but swallow context).

3. **`withClarification` wraps a `runAgent` callback** rather than taking `AgentBackend` directly. This keeps the middleware decoupled from backend details - the planner controls prompt construction, profile parsing, and scope parsing; the middleware only handles the clarification loop mechanics.

4. **`buildFailed` becomes an event-based signal.** The pipeline runner in `runBuildPipeline` checks whether a `build:failed` event was yielded during stage execution rather than reading a mutable context flag. The `buildFailed` field is removed from `BuildStageContext`. The implement stage in pipeline.ts already detects `build:failed` events (line 544) - it just needs to stop also setting `ctx.buildFailed`.

## Scope

### In Scope
- `collectAgentOutput` async generator helper in `common.ts`
- `yieldAndCollect` convenience wrapper in `common.ts`
- `withClarification` middleware in `common.ts`
- Error handling fixes in: `plan-evaluator.ts`, `cohesion-evaluator.ts`, `validation-fixer.ts`, `review-fixer.ts`
- Refactoring all agent runners to use `collectAgentOutput`: `builder.ts` (both implement and evaluate), `reviewer.ts`, `plan-reviewer.ts`, `plan-evaluator.ts`, `cohesion-reviewer.ts`, `cohesion-evaluator.ts`, `validation-fixer.ts`, `review-fixer.ts`, `merge-conflict-resolver.ts`, `module-planner.ts`, `assessor.ts`
- Refactoring `parallel-reviewer.ts` inner perspective loops to use `collectAgentOutput`
- Refactoring `planner.ts` to use `withClarification` + `collectAgentOutput`
- Removing `buildFailed` from `BuildStageContext`, making the pipeline runner event-driven
- Data-flow comment block at top of stage registry section in `pipeline.ts`
- Updating existing tests in `test/agent-wiring.test.ts` to cover new helpers
- Adding tests for `collectAgentOutput` and `withClarification` (can use `StubBackend`)

### Out of Scope
- Changing the `AgentBackend` interface itself
- Adding clarification support to agents other than the planner (the middleware makes it possible - wiring it in is future work)
- Refactoring prompt loading or XML parsing
- Changes to the monitor, CLI, or tracing layers

## Files

### Modify
- `src/engine/agents/common.ts` — Add `collectAgentOutput` async generator, `yieldAndCollect` convenience wrapper, and `withClarification` middleware. These are the shared extraction points for the repeated patterns.
- `src/engine/agents/planner.ts` — Replace inline clarification loop (~90 lines) with `withClarification` call. The planner-specific logic (scope parsing, profile parsing, module parsing, `formatPriorClarifications`, prompt building) stays; only the restart-on-clarification loop moves out. Also use `collectAgentOutput` for the inner backend.run() calls within the clarification wrapper.
- `src/engine/agents/builder.ts` — Refactor `builderImplement` and `builderEvaluate` to use `yieldAndCollect(collectAgentOutput(...))`. Error handling already follows the correct pattern - no changes needed there.
- `src/engine/agents/reviewer.ts` — Refactor `runReview` to use `yieldAndCollect`. No error handling changes needed (no try/catch currently).
- `src/engine/agents/plan-reviewer.ts` — Refactor `runPlanReview` to use `yieldAndCollect`. No error handling changes.
- `src/engine/agents/plan-evaluator.ts` — Refactor to use `yieldAndCollect`. Fix error handling: stop re-throwing after yielding the zero-count completion event. Catch block becomes: yield completion event, return. Re-throw only on `AbortError`.
- `src/engine/agents/cohesion-reviewer.ts` — Refactor `runCohesionReview` to use `yieldAndCollect`. No error handling changes.
- `src/engine/agents/cohesion-evaluator.ts` — Refactor to use `yieldAndCollect`. Fix error handling: same as plan-evaluator - stop re-throwing, return cleanly after yielding completion event. Re-throw only on `AbortError`.
- `src/engine/agents/validation-fixer.ts` — Refactor to use `yieldAndCollect(collectAgentOutput(...))`. Error handling already returns cleanly but swallows context - no structural change needed, just use the helper.
- `src/engine/agents/review-fixer.ts` — Refactor to use `yieldAndCollect`. Same error handling approach as validation-fixer.
- `src/engine/agents/merge-conflict-resolver.ts` — Refactor to use `yieldAndCollect`. Error handling already follows the correct pattern (yields `resolved: false`, returns).
- `src/engine/agents/module-planner.ts` — Refactor to use `yieldAndCollect`. No text accumulation needed (agent writes files directly), but the event iteration loop still benefits from the helper.
- `src/engine/agents/assessor.ts` — Refactor to use `yieldAndCollect` for the backend.run() loop.
- `src/engine/agents/parallel-reviewer.ts` — Refactor the inner perspective loop (lines 154-165) to use `collectAgentOutput`. The outer orchestration logic stays unchanged.
- `src/engine/pipeline.ts` — (1) Remove `buildFailed` from `BuildStageContext` interface. (2) In `runBuildPipeline`, track whether a `build:failed` event was yielded during each stage instead of reading `ctx.buildFailed`. (3) In the `implement` stage, remove `ctx.buildFailed = true` assignments (lines 552, 559) - the stage already yields `build:failed` events which the pipeline runner will now detect. (4) Add data-flow comment block above the stage registry section documenting which stages read/write which context fields.
- `test/agent-wiring.test.ts` — Add tests for `collectAgentOutput` (verifies event forwarding and text accumulation), `yieldAndCollect` (verifies convenience wrapper), and `withClarification` (verifies clarification loop, max iterations, auto-mode skip). Update existing agent tests if their event sequences change due to error handling fixes (plan-evaluator no longer throws, cohesion-evaluator no longer throws).

## Detail: `collectAgentOutput` Signature

```typescript
/**
 * Iterate a backend.run() stream, forwarding lifecycle events (and all events
 * when verbose), accumulating agent:message text. The generator's return value
 * is the accumulated text.
 */
export async function* collectAgentOutput(
  events: AsyncGenerator<EforgeEvent>,
  opts: { verbose?: boolean }
): AsyncGenerator<EforgeEvent, string> {
  let fullText = '';
  for await (const event of events) {
    if (isAlwaysYieldedAgentEvent(event) || opts.verbose) {
      yield event;
    }
    if (event.type === 'agent:message' && event.content) {
      fullText += event.content;
    }
  }
  return fullText;
}

/**
 * Convenience: iterate collectAgentOutput, yield all events, return accumulated text.
 * Use as: `const text = yield* yieldAndCollect(collectAgentOutput(events, opts));`
 */
export async function* yieldAndCollect(
  source: AsyncGenerator<EforgeEvent, string>
): AsyncGenerator<EforgeEvent, string> {
  let result = await source.next();
  while (!result.done) {
    yield result.value;
    result = await source.next();
  }
  return result.value;
}
```

Callers then use: `const fullText = yield* yieldAndCollect(collectAgentOutput(backend.run(...), { verbose }));`

This is a one-liner at each call site.

## Detail: `withClarification` Signature

```typescript
export interface ClarificationOptions {
  /** Callback to present questions and receive answers. If absent, clarifications are skipped. */
  onClarification?: (questions: ClarificationQuestion[]) => Promise<Record<string, string>>;
  /** Maximum clarification iterations before proceeding (default: 5) */
  maxIterations?: number;
  /** When true, skip clarification entirely (auto mode) */
  auto?: boolean;
}

/**
 * Wrap an agent runner with clarification loop support.
 *
 * @param runAgent - Function that takes a prompt string and returns an async generator.
 *   Called once per clarification iteration. The generator must yield EforgeEvents and
 *   return accumulated text (i.e., use collectAgentOutput internally or equivalent).
 * @param buildPrompt - Function that returns the prompt string, called before each iteration.
 *   Receives accumulated clarification history for injection into the prompt.
 * @param opts - Clarification configuration
 * @returns Async generator yielding EforgeEvents, returning accumulated text from final iteration
 */
export async function* withClarification(
  runAgent: (prompt: string) => AsyncGenerator<EforgeEvent, string>,
  buildPrompt: (priorClarifications: Array<{ questions: ClarificationQuestion[]; answers: Record<string, string> }>) => Promise<string>,
  opts: ClarificationOptions,
): AsyncGenerator<EforgeEvent, string>
```

## Detail: `buildFailed` Refactor

Current pipeline runner (`runBuildPipeline`):
```typescript
for (const stageName of ctx.profile.build) {
  const stage = getBuildStage(stageName);
  yield* stage(ctx);
  if (ctx.buildFailed) return;  // reads mutable flag
}
```

New pipeline runner:
```typescript
for (const stageName of ctx.profile.build) {
  const stage = getBuildStage(stageName);
  let failed = false;
  for await (const event of stage(ctx)) {
    yield event;
    if (event.type === 'build:failed') failed = true;
  }
  if (failed) return;
}
```

The implement stage removes its `ctx.buildFailed = true` assignments. The `buildFailed` field is removed from `BuildStageContext`.

## Verification

- [ ] `pnpm type-check` passes with zero errors
- [ ] `pnpm test` passes — all existing tests in `test/agent-wiring.test.ts` and `test/xml-parsers.test.ts` pass
- [ ] New test: `collectAgentOutput` forwards `agent:start`, `agent:stop`, `agent:result`, `agent:tool_use`, `agent:tool_result` events regardless of verbose flag
- [ ] New test: `collectAgentOutput` suppresses `agent:message` events when `verbose` is false
- [ ] New test: `collectAgentOutput` returns accumulated text from all `agent:message` events as the generator return value
- [ ] New test: `yieldAndCollect` yields all events from the inner generator and returns its return value
- [ ] New test: `withClarification` restarts the agent when clarification questions are detected and callback is provided
- [ ] New test: `withClarification` stops after `maxIterations` iterations
- [ ] New test: `withClarification` skips clarification when `auto` is true
- [ ] New test: `withClarification` returns accumulated text when no clarifications are found
- [ ] `plan-evaluator` no longer throws after yielding `plan:evaluate:complete` on error — yields event with `accepted: 0, rejected: 0` and returns
- [ ] `cohesion-evaluator` no longer throws after yielding `plan:cohesion:evaluate:complete` on error — yields event with `accepted: 0, rejected: 0` and returns
- [ ] `BuildStageContext` no longer has a `buildFailed` field — `pnpm type-check` confirms removal
- [ ] `runBuildPipeline` detects `build:failed` events from stage output rather than reading `ctx.buildFailed`
- [ ] Pipeline data-flow comment block exists at top of stage registry section in `pipeline.ts`
- [ ] No agent runner (except inside `withClarification` for abort propagation) re-throws non-abort errors
- [ ] `pnpm build` succeeds

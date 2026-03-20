---
id: plan-02-pipeline-and-prompts
name: Pipeline Stages, Builder Parameterization, and Planner Prompt Updates
depends_on: [plan-01-types-and-agents]
branch: tester-agent-separate-test-concerns-from-builder/pipeline-and-prompts
---

# Pipeline Stages, Builder Parameterization, and Planner Prompt Updates

## Architecture Context

This plan wires the agents from plan-01 into the build pipeline and updates planner/module-planner/builder prompts to know about test stages. The pipeline is the integration layer - it calls the agent runners, manages test-cycle looping, and converts TestIssues to ReviewIssues for the evaluate stage.

## Implementation

### Overview

Register four new build stages (`test-write`, `test`, `test-fix`, `test-cycle`), parameterize the builder's verification section via `{{verification_scope}}`, and update planner + module-planner prompts to document test stage availability and guidance.

### Key Decisions

1. The `implement` stage detects test stages by checking if any stage name in the flattened `ctx.build` starts with `test`. This is a pipeline-level concern - the builder prompt just receives `verification_scope` text.
2. `test-cycle` mirrors `review-cycle` exactly: loop `[test, test-fix, evaluate]` for `ctx.review.maxRounds` rounds, break early if no production issues.
3. `test-fix` reuses `runReviewFixer()` directly with TestIssues converted to ReviewIssues. No new agent needed.
4. The `test` stage stores issues in `ctx.reviewIssues` (converted via `testIssueToReviewIssue()`) so the existing evaluate stage can consume them unchanged.

## Scope

### In Scope
- Register `test-write`, `test`, `test-fix`, `test-cycle` in the build stage registry
- Builder prompt parameterization: `{{verification_scope}}` template variable
- `builderImplement()` accepts `verificationScope` option
- `implement` stage resolves verification scope from `ctx.build`
- Planner prompt: document test stages in "Per-Plan Build and Review Configuration" section
- Module-planner prompt: document test stages in "Build Configuration" section
- Export `DEFAULT_BUILD_WITH_TESTS` and `DEFAULT_BUILD_TDD` constants from `config.ts`

### Out of Scope
- Agent implementations (plan-01)
- CLI display and monitor UI (plan-03)
- Tests (plan-03)

## Files

### Modify
- `src/engine/pipeline.ts` — register four new build stages, update `implement` stage for verification scope detection
- `src/engine/agents/builder.ts` — add `verificationScope` to `BuilderOptions`, pass to prompt template
- `src/engine/prompts/builder.md` — replace hardcoded Verification section with `{{verification_scope}}` template
- `src/engine/prompts/planner.md` — add test stages to available stages list and guidance
- `src/engine/prompts/module-planner.md` — add test stages to build config documentation
- `src/engine/config.ts` — add `DEFAULT_BUILD_WITH_TESTS` and `DEFAULT_BUILD_TDD` constants

## Detailed Changes

### `src/engine/pipeline.ts`

**Update imports** (top of file):
```typescript
import { runTestWriter, runTester } from './agents/tester.js';
import { testIssueToReviewIssue } from './agents/common.js';
```

**Helper: detect test stages in build config**:
```typescript
function hasTestStages(build: BuildStageSpec[]): boolean {
  return build.some((spec) => {
    if (Array.isArray(spec)) return spec.some((s) => s.startsWith('test'));
    return spec.startsWith('test');
  });
}
```

**Update `implement` stage**: After creating the prompt in the implement stage, detect test stages and resolve `verificationScope`:
```typescript
const verificationScope = hasTestStages(ctx.build) ? 'build-only' : 'full';
```
Pass `verificationScope` to `builderImplement()`.

**Register `test-write` stage**:
```typescript
registerBuildStage('test-write', async function* testWriteStage(ctx) {
  const agentConfig = resolveAgentConfig('test-writer', ctx.config);
  const span = ctx.tracing.createSpan('test-writer', { planId: ctx.planId });
  span.setInput({ planId: ctx.planId });
  const tracker = createToolTracker(span);

  // Get implementation diff for post-implementation context
  let implementationContext = '';
  try {
    const { stdout } = await exec('git', ['diff', `${ctx.orchConfig.baseBranch}...HEAD`], { cwd: ctx.worktreePath });
    implementationContext = stdout;
  } catch {
    // No diff available (TDD mode) — that's fine
  }

  try {
    for await (const event of runTestWriter({
      backend: ctx.backend,
      cwd: ctx.worktreePath,
      planId: ctx.planId,
      planContent: ctx.planFile.body,
      implementationContext: implementationContext || undefined,
      verbose: ctx.verbose,
      abortController: ctx.abortController,
      maxTurns: agentConfig.maxTurns,
    })) {
      tracker.handleEvent(event);
      yield event;
    }
    tracker.cleanup();
    span.end();
  } catch (err) {
    tracker.cleanup();
    span.error(err as Error);
    if (err instanceof Error && err.name === 'AbortError') throw err;
  }
});
```

**Register `test` stage**:
```typescript
registerBuildStage('test', async function* testStage(ctx) {
  yield* testStageInner(ctx);
});

async function* testStageInner(ctx: BuildStageContext): AsyncGenerator<EforgeEvent> {
  const agentConfig = resolveAgentConfig('tester', ctx.config);
  const span = ctx.tracing.createSpan('tester', { planId: ctx.planId });
  span.setInput({ planId: ctx.planId });
  const tracker = createToolTracker(span);

  try {
    for await (const event of runTester({
      backend: ctx.backend,
      cwd: ctx.worktreePath,
      planId: ctx.planId,
      planContent: ctx.planFile.body,
      verbose: ctx.verbose,
      abortController: ctx.abortController,
      maxTurns: agentConfig.maxTurns,
    })) {
      tracker.handleEvent(event);
      yield event;

      // Convert test issues to review issues for evaluate stage consumption
      if (event.type === 'build:test:complete' && event.productionIssues.length > 0) {
        ctx.reviewIssues = event.productionIssues.map(testIssueToReviewIssue);
      }
    }
    tracker.cleanup();
    span.end();
  } catch (err) {
    tracker.cleanup();
    span.error(err as Error);
    if (err instanceof Error && err.name === 'AbortError') throw err;
  }
}
```

**Register `test-fix` stage**: Reuses `reviewFixStageInner()`:
```typescript
registerBuildStage('test-fix', async function* testFixStage(ctx) {
  yield* reviewFixStageInner(ctx);
});
```

**Register `test-cycle` stage**: Mirrors `review-cycle`:
```typescript
registerBuildStage('test-cycle', async function* testCycleStage(ctx) {
  const maxRounds = ctx.review.maxRounds;
  const strictness = ctx.review.evaluatorStrictness;

  for (let round = 0; round < maxRounds; round++) {
    // 1. Test
    yield* testStageInner(ctx);

    // 2. Break if no production issues
    if (ctx.reviewIssues.length === 0) break;

    // 3. Test-fix (reuses review-fix plumbing)
    yield* reviewFixStageInner(ctx);

    // 4. Evaluate
    yield* evaluateStageInner(ctx, { strictness });
  }
});
```

### `src/engine/agents/builder.ts`

Add `verificationScope` to `BuilderOptions`:
```typescript
export interface BuilderOptions {
  // ...existing fields...
  /** Verification scope: 'full' runs all checks, 'build-only' skips tests (handled by test stages) */
  verificationScope?: 'full' | 'build-only';
}
```

Update `builderImplement()` to pass `verification_scope` to the prompt template:
```typescript
const verificationScopeText = options.verificationScope === 'build-only'
  ? VERIFICATION_BUILD_ONLY
  : VERIFICATION_FULL;

const prompt = await loadPrompt('builder', {
  plan_id: plan.id,
  plan_name: plan.name,
  plan_content: plan.body,
  plan_branch: plan.branch,
  parallelLanes,
  verification_scope: verificationScopeText,
});
```

Add verification text constants:
```typescript
const VERIFICATION_FULL = `Before committing, run the verification commands specified in the plan's "Verification" section. If the plan specifies:
- Type checking (e.g., \`pnpm type-check\`) — run it and fix any errors
- Build (e.g., \`pnpm build\`) — run it and fix any errors
- Tests — run them and fix any failures

Fix any issues that arise from verification. Only proceed to commit when all verification passes.`;

const VERIFICATION_BUILD_ONLY = `Before committing, run type checking and build commands from the plan's "Verification" section:
- Type checking (e.g., \`pnpm type-check\`) — run it and fix any errors
- Build (e.g., \`pnpm build\`) — run it and fix any errors

Do NOT run tests — test verification is handled by dedicated test stages in the pipeline.

Fix any issues that arise from verification. Only proceed to commit when all verification passes.`;
```

### `src/engine/prompts/builder.md`

Replace the Verification section (lines 40-47) with:

```markdown
## Verification

{{verification_scope}}
```

### `src/engine/prompts/planner.md`

In the "Per-Plan Build and Review Configuration" section, update the available stages line:

Change:
```
Available stages: `implement`, `doc-update`, `review`, `review-fix`, `evaluate`, `validate`, `review-cycle`.
```
To:
```
Available stages: `implement`, `doc-update`, `test-write`, `test`, `test-fix`, `test-cycle`, `review`, `review-fix`, `evaluate`, `validate`, `review-cycle`.
```

Add after the `review-cycle` description:

```markdown
**`test-cycle`** is a composite stage that expands to `[test, test-fix, evaluate]`. Use it when the plan has testable behavior. The tester agent runs tests, fixes test bugs, and reports production issues. `test-fix` and `evaluate` handle production fix application and judgment.

**`test-write`** runs before `implement` in TDD mode — it writes tests from the plan spec that initially fail. After `implement`, a `test-cycle` validates the implementation.

**Test stage guidance:**
- Plans with testable behavior: `build: [implement, test-cycle, review-cycle]`
- TDD for well-specified features: `build: [test-write, implement, test-cycle]`
- Config changes, simple refactors, doc-only work: omit test stages
- Time-optimized: `build: [implement, [test-cycle, review-cycle]]` (parallel test + review)
```

### `src/engine/prompts/module-planner.md`

In the "Build Configuration" section, update the `build` field description:

Change:
```
`review-cycle` is a composite stage that expands to `[review, review-fix, evaluate]`.
```
To:
```
`review-cycle` is a composite stage that expands to `[review, review-fix, evaluate]`. `test-cycle` expands to `[test, test-fix, evaluate]` — use it when the module has testable behavior.
```

Add to the guidance paragraph:
```
For modules with testable features, include `test-cycle` after `implement`: `[implement, test-cycle, review-cycle]`. For TDD, place `test-write` before `implement`: `[test-write, implement, test-cycle]`.
```

### `src/engine/config.ts`

Add after `DEFAULT_BUILD_WITH_DOCS` (line 243):
```typescript
/** Default build stages with test cycle (build-then-test). */
export const DEFAULT_BUILD_WITH_TESTS: BuildStageSpec[] = Object.freeze([
  'implement', 'test-cycle', 'review-cycle',
]) as unknown as BuildStageSpec[];

/** Default build stages for TDD workflow. */
export const DEFAULT_BUILD_TDD: BuildStageSpec[] = Object.freeze([
  'test-write', 'implement', 'test-cycle',
]) as unknown as BuildStageSpec[];
```

## Verification

- [ ] `pnpm type-check` passes with zero errors
- [ ] `pnpm build` produces `dist/cli.js` without errors
- [ ] `pnpm test` — all existing tests pass (no regressions)
- [ ] `getBuildStageNames()` from `pipeline.ts` includes `'test-write'`, `'test'`, `'test-fix'`, and `'test-cycle'`
- [ ] `builderImplement()` accepts a `verificationScope` option and passes it through to the prompt
- [ ] Builder prompt contains `{{verification_scope}}` template variable (not hardcoded verification text)
- [ ] Planner prompt lists `test-write`, `test`, `test-fix`, `test-cycle` as available build stages
- [ ] Module-planner prompt documents `test-cycle` as a composite stage

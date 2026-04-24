/**
 * Built-in build stages — all ten build stage registrations plus shared inner helpers.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { EforgeEvent } from '../../events.js';
import type { BuildStageSpec } from '../../config.js';
import {
  withRetry,
  DEFAULT_RETRY_POLICIES,
  type RetryPolicy,
  type BuilderContinuationInput,
  type EvaluatorContinuationInput,
} from '../../retry.js';
import { builderImplement, builderEvaluate } from '../../agents/builder.js';
import { runParallelReview } from '../../agents/parallel-reviewer.js';
import { runReviewFixer } from '../../agents/review-fixer.js';
import { runDocUpdater } from '../../agents/doc-updater.js';
import { runTestWriter, runTester } from '../../agents/tester.js';
import { testIssueToReviewIssue } from '../../agents/common.js';
import type { ResolvedAgentConfig } from '../../config.js';

import type { BuildStageContext } from '../types.js';
import { registerBuildStage } from '../registry.js';
import { resolveAgentConfig } from '../agent-config.js';
import { createToolTracker } from '../span-wiring.js';
import { hasUnstagedChanges, withPeriodicFileCheck, emitFilesChanged } from '../git-helpers.js';
import { toBuildFailedEvent } from '../error-translator.js';
import { filterIssuesBySeverity } from '../misc.js';

const exec = promisify(execFile);

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function hasTestStages(build: BuildStageSpec[]): boolean {
  return build.some((spec) => {
    if (Array.isArray(spec)) return spec.some((s) => s.startsWith('test'));
    return spec.startsWith('test');
  });
}

/** Per-retry builder span + event processing. Span and tracker created per-attempt. */
async function* runBuilderAttempt(
  input: BuilderContinuationInput,
  ctx: BuildStageContext,
  agentConfig: ResolvedAgentConfig,
  parallelStages: string[][],
  verificationScope: 'build-only' | 'full',
): AsyncGenerator<EforgeEvent> {
  const implSpan = ctx.tracing.createSpan('builder', { planId: ctx.planId, phase: 'implement' });
  implSpan.setInput({ planId: ctx.planId, phase: 'implement' });
  const implTracker = createToolTracker(implSpan);
  try {
    for await (const event of withPeriodicFileCheck(builderImplement(ctx.planFile, {
      cwd: ctx.worktreePath,
      verbose: ctx.verbose,
      abortController: ctx.abortController,
      ...agentConfig,
      parallelStages,
      verificationScope,
      ...(input.builderOptions.continuationContext && { continuationContext: input.builderOptions.continuationContext }),
      harness: ctx.agentRuntimes.forRole('builder'),
    }), ctx)) {
      implTracker.handleEvent(event);
      if (event.type === 'plan:build:failed') implSpan.error('Implementation failed');
      yield event;
    }
    implTracker.cleanup();
    implSpan.end();
  } catch (err) {
    implTracker.cleanup();
    implSpan.error(err as Error);
    throw err;
  }
}

/** Per-retry evaluator span + event processing. Span and tracker created per-attempt. */
async function* runEvaluatorAttempt(
  input: EvaluatorContinuationInput,
  ctx: BuildStageContext,
  evalAgentConfig: ResolvedAgentConfig,
  strictness?: 'strict' | 'standard' | 'lenient',
): AsyncGenerator<EforgeEvent> {
  const evalSpan = ctx.tracing.createSpan('evaluator', { planId: ctx.planId });
  evalSpan.setInput({ planId: ctx.planId });
  const evalTracker = createToolTracker(evalSpan);
  try {
    const continuationContext = input.evaluatorOptions.evaluatorContinuationContext as { attempt: number; maxContinuations: number } | undefined;
    for await (const event of builderEvaluate(ctx.planFile, {
      cwd: ctx.worktreePath,
      verbose: ctx.verbose,
      abortController: ctx.abortController,
      ...evalAgentConfig,
      strictness,
      ...(continuationContext && { evaluatorContinuationContext: continuationContext }),
      preImplementCommit: ctx.preImplementCommit,
      harness: ctx.agentRuntimes.forRole('evaluator'),
    })) {
      evalTracker.handleEvent(event);
      if (event.type === 'plan:build:failed') evalSpan.error('Evaluation failed');
      yield event;
    }
    evalTracker.cleanup();
    evalSpan.end();
  } catch (err) {
    evalTracker.cleanup();
    evalSpan.error(err as Error);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Inner stage helpers (called by composite stages)
// ---------------------------------------------------------------------------

async function* reviewStageInner(
  ctx: BuildStageContext,
  overrides?: { strategy?: 'auto' | 'single' | 'parallel'; perspectives?: string[] },
): AsyncGenerator<EforgeEvent> {
  const strategy = overrides?.strategy ?? ctx.review.strategy;
  const perspectives = overrides?.perspectives ?? (ctx.review.perspectives.length > 0 ? ctx.review.perspectives : undefined);
  const reviewerAgentConfig = resolveAgentConfig('reviewer', ctx.config, ctx.planFile);
  const reviewSpan = ctx.tracing.createSpan('reviewer', { planId: ctx.planId, phase: 'review' });
  reviewSpan.setInput({ planId: ctx.planId, phase: 'review' });
  const reviewTracker = createToolTracker(reviewSpan);
  try {
    for await (const event of runParallelReview({
      planContent: ctx.planFile.body,
      baseBranch: ctx.orchConfig.baseBranch,
      planId: ctx.planId,
      cwd: ctx.worktreePath,
      verbose: ctx.verbose,
      abortController: ctx.abortController,
      strategy,
      perspectives,
      ...reviewerAgentConfig,
      harness: ctx.agentRuntimes.forRole('reviewer'),
    })) {
      reviewTracker.handleEvent(event);
      yield event;
      if (event.type === 'plan:build:review:complete') ctx.reviewIssues = event.issues;
    }
    reviewTracker.cleanup();
    reviewSpan.end();
  } catch (err) {
    reviewTracker.cleanup();
    reviewSpan.error(err as Error);
  }
}

async function* evaluateStageInner(
  ctx: BuildStageContext,
  overrides?: { strictness?: 'strict' | 'standard' | 'lenient' },
): AsyncGenerator<EforgeEvent> {
  if (!(await hasUnstagedChanges(ctx.worktreePath))) return;
  const strictness = overrides?.strictness ?? ctx.review.evaluatorStrictness;
  const evalAgentConfig = resolveAgentConfig('evaluator', ctx.config, ctx.planFile);
  const initialInput: EvaluatorContinuationInput = {
    worktreePath: ctx.worktreePath,
    planId: ctx.planId,
    evaluatorOptions: {},
  };
  const evaluatorPolicy = DEFAULT_RETRY_POLICIES.evaluator as RetryPolicy<EvaluatorContinuationInput>;
  try {
    for await (const event of withRetry(
      (input) => runEvaluatorAttempt(input, ctx, evalAgentConfig, strictness),
      evaluatorPolicy,
      initialInput,
    )) {
      yield event;
    }
  } catch {
    // Per-attempt spans already recorded errors; swallow so evaluator stays non-fatal.
  }
}

async function* reviewFixStageInner(ctx: BuildStageContext): AsyncGenerator<EforgeEvent> {
  if (ctx.reviewIssues.length === 0) return;
  const fixerConfig = resolveAgentConfig('review-fixer', ctx.config, ctx.planFile);
  const fixSpan = ctx.tracing.createSpan('review-fixer', { planId: ctx.planId });
  fixSpan.setInput({ planId: ctx.planId, issueCount: ctx.reviewIssues.length });
  const fixTracker = createToolTracker(fixSpan);
  try {
    for await (const event of withPeriodicFileCheck(runReviewFixer({
      planId: ctx.planId,
      cwd: ctx.worktreePath,
      issues: ctx.reviewIssues,
      verbose: ctx.verbose,
      abortController: ctx.abortController,
      ...fixerConfig,
      harness: ctx.agentRuntimes.forRole('review-fixer'),
    }), ctx)) {
      fixTracker.handleEvent(event);
      yield event;
    }
    fixTracker.cleanup();
    fixSpan.end();
  } catch (err) {
    fixTracker.cleanup();
    fixSpan.error(err as Error);
    if (err instanceof Error && err.name === 'AbortError') throw err;
    // Review fixer failures are non-fatal
  }
}

async function* testStageInner(ctx: BuildStageContext): AsyncGenerator<EforgeEvent> {
  const agentConfig = resolveAgentConfig('tester', ctx.config, ctx.planFile);
  const span = ctx.tracing.createSpan('tester', { planId: ctx.planId });
  span.setInput({ planId: ctx.planId });
  const tracker = createToolTracker(span);
  try {
    for await (const event of withPeriodicFileCheck(runTester({
      cwd: ctx.worktreePath,
      planId: ctx.planId,
      planContent: ctx.planFile.body,
      verbose: ctx.verbose,
      abortController: ctx.abortController,
      ...agentConfig,
      harness: ctx.agentRuntimes.forRole('tester'),
    }), ctx)) {
      tracker.handleEvent(event);
      yield event;
      if (event.type === 'plan:build:test:complete') {
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

// ---------------------------------------------------------------------------
// Built-in Build Stages
// ---------------------------------------------------------------------------

registerBuildStage({
  name: 'implement',
  phase: 'build',
  description: 'Runs the builder agent to implement the plan in a worktree with continuation support.',
  whenToUse: 'Always included as the first build stage. This is where actual code changes are made.',
  costHint: 'high',
  parallelizable: false,
}, async function* implementStage(ctx) {
  // Capture the current HEAD before the builder commits — used by the evaluator as reset target
  try {
    const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd: ctx.worktreePath });
    ctx.preImplementCommit = stdout.trim();
  } catch {
    // Fresh repo or no commits — evaluator will fall back to HEAD~1
  }

  // Resolve maxContinuations: per-plan > global config > default (3)
  const agentConfig = resolveAgentConfig('builder', ctx.config, ctx.planFile);
  const maxContinuations = ctx.planEntry?.maxContinuations ?? ctx.config.agents.maxContinuations;
  const parallelStages = ctx.build.filter((spec): spec is string[] => Array.isArray(spec));
  const verificationScope = hasTestStages(ctx.build) ? 'build-only' : 'full';

  const initialInput: BuilderContinuationInput = {
    worktreePath: ctx.worktreePath,
    baseBranch: ctx.orchConfig.baseBranch,
    planId: ctx.planId,
    builderOptions: {},
  };

  // Policy with a per-plan override for maxAttempts (prior behavior: maxContinuations + 1).
  const builderPolicy: RetryPolicy<BuilderContinuationInput> = {
    ...(DEFAULT_RETRY_POLICIES.builder as RetryPolicy<BuilderContinuationInput>),
    maxAttempts: maxContinuations + 1,
  };

  try {
    for await (const event of withRetry(
      (input) => runBuilderAttempt(input, ctx, agentConfig, parallelStages, verificationScope),
      builderPolicy,
      initialInput,
    )) {
      if (event.type === 'plan:build:failed') {
        yield event;
        ctx.buildFailed = true;
        return;
      }
      yield event;
    }
  } catch (err) {
    yield toBuildFailedEvent(ctx.planId, err);
    ctx.buildFailed = true;
    return;
  }

  yield* emitFilesChanged(ctx);
});

registerBuildStage({
  name: 'review',
  phase: 'build',
  description: 'Runs a single code review pass identifying issues in the implementation.',
  whenToUse: 'When a single review pass is sufficient. For iterative review-fix cycles, use review-cycle instead.',
  costHint: 'medium',
  predecessors: ['implement'],
}, async function* reviewStage(ctx) {
  yield* reviewStageInner(ctx);
});

registerBuildStage({
  name: 'evaluate',
  phase: 'build',
  description: 'Evaluates unstaged changes from review/fixer, accepting or rejecting each change.',
  whenToUse: 'After review-fix to gate which reviewer suggestions are kept. Used within review-cycle.',
  costHint: 'medium',
  predecessors: ['implement'],
}, async function* evaluateStage(ctx) {
  yield* evaluateStageInner(ctx);
});

registerBuildStage({
  name: 'review-fix',
  phase: 'build',
  description: 'Applies fixes for review issues identified by the reviewer agent.',
  whenToUse: 'After review to fix identified issues. Typically used within review-cycle rather than standalone.',
  costHint: 'medium',
  predecessors: ['implement'],
}, async function* reviewFixStage(ctx) {
  yield* reviewFixStageInner(ctx);
});

registerBuildStage({
  name: 'review-cycle',
  phase: 'build',
  description: 'Runs iterative review-fix-evaluate rounds up to maxRounds, stopping when no actionable issues remain.',
  whenToUse: 'For quality-critical implementations. Combines review, review-fix, and evaluate into an iterative loop.',
  costHint: 'high',
  predecessors: ['implement'],
  conflictsWith: ['review'],
  parallelizable: false,
}, async function* reviewCycleStage(ctx) {
  const maxRounds = ctx.review.maxRounds;
  const strategy = ctx.review.strategy;
  const perspectives = ctx.review.perspectives.length > 0 ? ctx.review.perspectives : undefined;
  const autoAcceptBelow = ctx.review.autoAcceptBelow;
  const strictness = ctx.review.evaluatorStrictness;

  for (let round = 0; round < maxRounds; round++) {
    yield* reviewStageInner(ctx, { strategy, perspectives });
    const { filtered } = filterIssuesBySeverity(ctx.reviewIssues, autoAcceptBelow);
    ctx.reviewIssues = filtered;
    if (filtered.length === 0) break;
    yield* reviewFixStageInner(ctx);
    yield* evaluateStageInner(ctx, { strictness });
  }
});

registerBuildStage({
  name: 'validate',
  phase: 'build',
  description: 'Placeholder for inline validation. Custom pipelines can include this for pre-merge checks.',
  whenToUse: 'When inline validation is needed before merge. Post-merge validation is handled by the Orchestrator.',
  costHint: 'low',
  predecessors: ['implement'],
}, async function* validateStage(_ctx) {
  // Placeholder for inline validation (not used in default pipelines).
  // Post-merge validation continues to be handled by the Orchestrator.
});

registerBuildStage({
  name: 'doc-update',
  phase: 'build',
  description: 'Updates project documentation to reflect implementation changes.',
  whenToUse: 'After implementation to keep docs in sync. Can run in parallel with review stages.',
  costHint: 'medium',
  predecessors: ['implement'],
}, async function* docUpdateStage(ctx) {
  const agentConfig = resolveAgentConfig('doc-updater', ctx.config, ctx.planFile);
  const docSpan = ctx.tracing.createSpan('doc-updater', { planId: ctx.planId });
  docSpan.setInput({ planId: ctx.planId });
  const docTracker = createToolTracker(docSpan);
  try {
    for await (const event of withPeriodicFileCheck(runDocUpdater({
      cwd: ctx.worktreePath,
      planId: ctx.planId,
      planContent: ctx.planFile.body,
      verbose: ctx.verbose,
      abortController: ctx.abortController,
      ...agentConfig,
      harness: ctx.agentRuntimes.forRole('doc-updater'),
    }), ctx)) {
      docTracker.handleEvent(event);
      yield event;
    }
    docTracker.cleanup();
    docSpan.end();
  } catch (err) {
    docTracker.cleanup();
    docSpan.error(err as Error);
    if (err instanceof Error && err.name === 'AbortError') throw err;
    // Doc-update failure is non-fatal — don't propagate
  }
  yield* emitFilesChanged(ctx);
});

registerBuildStage({
  name: 'test-write',
  phase: 'build',
  description: 'Writes test cases for the implementation using the test-writer agent.',
  whenToUse: 'When automated test generation is desired. Can run after or in parallel with implementation.',
  costHint: 'medium',
  predecessors: ['implement'],
}, async function* testWriteStage(ctx) {
  const agentConfig = resolveAgentConfig('test-writer', ctx.config, ctx.planFile);
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
    for await (const event of withPeriodicFileCheck(runTestWriter({
      cwd: ctx.worktreePath,
      planId: ctx.planId,
      planContent: ctx.planFile.body,
      implementationContext: implementationContext || undefined,
      verbose: ctx.verbose,
      abortController: ctx.abortController,
      ...agentConfig,
      harness: ctx.agentRuntimes.forRole('test-writer'),
    }), ctx)) {
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
  yield* emitFilesChanged(ctx);
});

registerBuildStage({
  name: 'test',
  phase: 'build',
  description: 'Runs the tester agent to execute tests and identify production code issues.',
  whenToUse: 'When test execution and production issue detection is needed. Used within test-cycle.',
  costHint: 'medium',
  predecessors: ['implement'],
}, async function* testStage(ctx) {
  yield* testStageInner(ctx);
});

registerBuildStage({
  name: 'test-cycle',
  phase: 'build',
  description: 'Runs iterative test-evaluate rounds up to maxRounds, stopping when no production issues remain.',
  whenToUse: 'For test-driven quality assurance. Combines test and evaluate into an iterative loop.',
  costHint: 'high',
  predecessors: ['implement'],
  conflictsWith: ['test'],
  parallelizable: false,
}, async function* testCycleStage(ctx) {
  const maxRounds = ctx.review.maxRounds;
  const strictness = ctx.review.evaluatorStrictness;
  for (let round = 0; round < maxRounds; round++) {
    yield* testStageInner(ctx);
    if (ctx.reviewIssues.length === 0) break;
    yield* evaluateStageInner(ctx, { strictness });
  }
});

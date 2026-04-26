/**
 * Built-in build stages — all ten build stage registrations plus shared inner helpers.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { EforgeEvent } from '../../events.js';
import type { BuildStageSpec, ShardScope } from '../../config.js';
import {
  withRetry,
  DEFAULT_RETRY_POLICIES,
  type RetryPolicy,
  type BuilderContinuationInput,
  type BuilderShardContinuationInput,
  type EvaluatorContinuationInput,
  buildShardPolicy,
} from '../../retry.js';
import { builderImplement, builderEvaluate } from '../../agents/builder.js';
import { runParallelReview } from '../../agents/parallel-reviewer.js';
import { runReviewFixer } from '../../agents/review-fixer.js';
import { runDocUpdater } from '../../agents/doc-updater.js';
import { runTestWriter, runTester } from '../../agents/tester.js';
import { testIssueToReviewIssue } from '../../agents/common.js';
import type { ResolvedAgentConfig } from '../../config.js';
import { runParallel } from '../../concurrency.js';
import { forgeCommit } from '../../git.js';
import { composeCommitMessage } from '../../model-tracker.js';

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
// Shard helpers
// ---------------------------------------------------------------------------

/**
 * Determine whether a shard claims a given file path.
 * Roots are matched by path prefix (with or without trailing slash).
 * Files are matched by exact path.
 */
function shardClaimsFile(shard: ShardScope, file: string): boolean {
  if (shard.roots) {
    for (const root of shard.roots) {
      const prefix = root.endsWith('/') ? root : `${root}/`;
      if (file.startsWith(prefix) || file === root) return true;
    }
  }
  if (shard.files) {
    for (const f of shard.files) {
      if (file === f) return true;
    }
  }
  return false;
}

/**
 * Enforce that all staged files are claimed by exactly one shard.
 * Returns ok:true when all files match exactly one shard.
 * Returns ok:false with reason and offending files when:
 * - 'unclaimed': a file is not claimed by any shard
 * - 'overlap': a file is claimed by multiple shards (includes claiming shard IDs)
 */
export function enforceShardScope(
  stagedFiles: string[],
  shards: ShardScope[],
): { ok: true } | { ok: false; reason: 'unclaimed' | 'overlap'; files: string[]; shardIds?: string[][] } {
  const unclaimedFiles: string[] = [];
  const overlappingFiles: string[] = [];
  const overlappingShardIds: string[][] = [];

  for (const file of stagedFiles) {
    const claimingShards = shards.filter((s) => shardClaimsFile(s, file));
    if (claimingShards.length === 0) {
      unclaimedFiles.push(file);
    } else if (claimingShards.length > 1) {
      overlappingFiles.push(file);
      overlappingShardIds.push(claimingShards.map((s) => s.id));
    }
  }

  if (unclaimedFiles.length > 0) {
    return { ok: false, reason: 'unclaimed', files: unclaimedFiles };
  }
  if (overlappingFiles.length > 0) {
    return { ok: false, reason: 'overlap', files: overlappingFiles, shardIds: overlappingShardIds };
  }
  return { ok: true };
}

/**
 * Extract and run verification commands from a plan body.
 * Commands are extracted from backtick-quoted strings in the "## Verification" section.
 * In build-only mode, test commands (containing 'test', 'jest', 'vitest') are skipped.
 * Yields a plan:build:failed event if any command fails.
 */
async function* runVerificationCommands(
  planBody: string,
  cwd: string,
  planId: string,
  verificationScope: 'full' | 'build-only',
): AsyncGenerator<EforgeEvent> {
  // Find the Verification section. The lookahead must terminate at the next
  // `## ` heading or at the true end of the string. `\s*$` with the `m` flag
  // matches the end of *any* line, so a previous version of this regex
  // truncated the section after the first newline and dropped every command
  // beyond the first one. Use `$(?![\s\S])` (and `\n##\s` instead of `^##\s`
  // so the `m` flag is unnecessary) to anchor only at end-of-input.
  const sectionMatch = planBody.match(/^##\s+Verification\s*\n([\s\S]*?)(?=\n##\s|$(?![\s\S]))/m);
  if (!sectionMatch) return;

  const section = sectionMatch[1];

  // Extract commands in backticks (pnpm/npm/npx/yarn only)
  const commands: string[] = [];
  const cmdPattern = /`((?:pnpm|npm|npx|yarn)\s+[^`]+)`/g;
  let m;
  while ((m = cmdPattern.exec(section)) !== null) {
    commands.push(m[1].trim());
  }

  // Deduplicate
  const unique = [...new Set(commands)];

  // Filter for build-only: skip test commands
  const filtered = verificationScope === 'build-only'
    ? unique.filter((cmd) => !/\b(test|jest|vitest)\b/.test(cmd))
    : unique;

  for (const cmd of filtered) {
    const parts = cmd.split(/\s+/);
    const prog = parts[0];
    const args = parts.slice(1);
    try {
      await exec(prog, args, { cwd });
    } catch (err) {
      const stderr = (err as NodeJS.ErrnoException & { stderr?: string }).stderr ?? '';
      const stdout = (err as NodeJS.ErrnoException & { stdout?: string }).stdout ?? '';
      const output = (stdout + stderr).trim() || (err as Error).message;
      yield {
        timestamp: new Date().toISOString(),
        type: 'plan:build:failed',
        planId,
        error: `Shard coordinator verification failed (${cmd}): ${output}`,
      };
      return;
    }
  }
}

/** Per-shard-attempt span + event processing. Creates a new span per attempt. */
async function* runBuilderShardAttempt(
  input: BuilderShardContinuationInput,
  ctx: BuildStageContext,
  agentConfig: ResolvedAgentConfig,
  parallelStages: string[][],
): AsyncGenerator<EforgeEvent> {
  const implSpan = ctx.tracing.createSpan('builder', { planId: ctx.planId, phase: 'implement', shardId: input.shardId });
  implSpan.setInput({ planId: ctx.planId, phase: 'implement', shardId: input.shardId });
  const implTracker = createToolTracker(implSpan);
  try {
    for await (const event of withPeriodicFileCheck(builderImplement(ctx.planFile, {
      cwd: ctx.worktreePath,
      verbose: ctx.verbose,
      abortController: ctx.abortController,
      ...agentConfig,
      parallelStages,
      // verificationScope is intentionally omitted: shardScope instructs the agent not to verify
      shardScope: input.shardScope,
      ...(input.builderOptions.continuationContext && { continuationContext: input.builderOptions.continuationContext }),
      harness: ctx.agentRuntimes.forRole('builder'),
    }), ctx)) {
      implTracker.handleEvent(event);
      if (event.type === 'plan:build:failed') implSpan.error('Shard implementation failed');
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

/** Run a single shard with its own retry policy. Yields all events including plan:build:failed on exhaustion. */
async function* runShardAttempt(
  shard: ShardScope,
  ctx: BuildStageContext,
  agentConfig: ResolvedAgentConfig,
  parallelStages: string[][],
  maxContinuations: number,
): AsyncGenerator<EforgeEvent> {
  const shardPolicy = buildShardPolicy(shard.id, maxContinuations + 1);

  const initialInput: BuilderShardContinuationInput = {
    worktreePath: ctx.worktreePath,
    baseBranch: ctx.orchConfig.baseBranch,
    planId: ctx.planId,
    shardId: shard.id,
    shardScope: shard,
    builderOptions: {},
  };

  try {
    for await (const event of withRetry(
      (input) => runBuilderShardAttempt(input, ctx, agentConfig, parallelStages),
      shardPolicy,
      initialInput,
    )) {
      yield event;
    }
  } catch (err) {
    yield toBuildFailedEvent(ctx.planId, err);
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

  const shards = agentConfig.shards;

  if (!shards || shards.length === 0) {
    // -----------------------------------------------------------------------
    // Single-builder flow (unchanged from before sharding was added)
    // -----------------------------------------------------------------------
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
  } else {
    // -----------------------------------------------------------------------
    // Sharded flow: fan out to N parallel builders, then coordinator phase
    // -----------------------------------------------------------------------
    let anyShardFailed = false;

    const tasks = shards.map((shard) => ({
      id: shard.id,
      run: (): AsyncGenerator<EforgeEvent> =>
        runShardAttempt(shard, ctx, agentConfig, parallelStages, maxContinuations),
    }));

    // Fan out: run all shards concurrently, collecting events
    for await (const event of runParallel(tasks, { parallelism: shards.length })) {
      if (event.type === 'plan:build:failed') {
        anyShardFailed = true;
      }
      yield event;
    }

    if (anyShardFailed) {
      ctx.buildFailed = true;
      return;
    }

    // -----------------------------------------------------------------------
    // Coordinator phase: scope enforcement → verification → single commit
    // -----------------------------------------------------------------------

    // Safety sweep: stage any working-tree changes left unstaged by shard agents so
    // they are visible to scope enforcement rather than silently dropped or bypassed.
    try {
      await exec('git', ['add', '-A'], { cwd: ctx.worktreePath });
    } catch (err) {
      yield toBuildFailedEvent(ctx.planId, err);
      ctx.buildFailed = true;
      return;
    }

    // Scope enforcement: every staged file must be claimed by exactly one shard
    try {
      const { stdout: stagedOut } = await exec('git', ['diff', '--cached', '--name-only'], { cwd: ctx.worktreePath });
      const stagedFiles = stagedOut.trim().split('\n').filter(Boolean);

      if (stagedFiles.length > 0) {
        const scopeResult = enforceShardScope(stagedFiles, shards);
        if (!scopeResult.ok) {
          let errorMsg: string;
          if (scopeResult.reason === 'unclaimed') {
            errorMsg = `Shard scope enforcement failed: files staged outside any shard scope: ${scopeResult.files.join(', ')}`;
          } else {
            const fileList = scopeResult.files.map((f, i) => {
              const ids = scopeResult.shardIds?.[i]?.join(', ') ?? '?';
              return `${f} (claimed by: ${ids})`;
            }).join(', ');
            errorMsg = `Shard scope enforcement failed: files claimed by multiple shards: ${fileList}`;
          }
          yield { timestamp: new Date().toISOString(), type: 'plan:build:failed', planId: ctx.planId, error: errorMsg };
          ctx.buildFailed = true;
          return;
        }
      }
    } catch (err) {
      yield toBuildFailedEvent(ctx.planId, err);
      ctx.buildFailed = true;
      return;
    }

    // Verification (coordinator runs once across all shards)
    let verificationFailed = false;
    for await (const event of runVerificationCommands(ctx.planFile.body, ctx.worktreePath, ctx.planId, verificationScope)) {
      yield event;
      if (event.type === 'plan:build:failed') {
        verificationFailed = true;
      }
    }
    if (verificationFailed) {
      ctx.buildFailed = true;
      return;
    }

    // Single coordinator commit
    try {
      const commitMsg = `feat(${ctx.planId}): ${ctx.planFile.name}`;
      await forgeCommit(ctx.worktreePath, composeCommitMessage(commitMsg, ctx.modelTracker));
    } catch (err) {
      yield toBuildFailedEvent(ctx.planId, err);
      ctx.buildFailed = true;
      return;
    }

    yield { timestamp: new Date().toISOString(), type: 'plan:build:implement:complete', planId: ctx.planId };
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

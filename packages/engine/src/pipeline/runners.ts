/**
 * Pipeline runners — runCompilePipeline, runBuildPipeline, and the shared runReviewCycle helper.
 *
 * runReviewCycle is co-located here (rather than in the stages files) so that both
 * compile-stages and build-stages can import it without creating a cross-import cycle
 * between the two stages modules.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { EforgeEvent, AgentRole } from '../events.js';
import type { TracingContext } from '../tracing.js';
import {
  withRetry,
  DEFAULT_RETRY_POLICIES,
  type RetryPolicy,
  type EvaluatorContinuationInput,
} from '../retry.js';
import { runParallel, type ParallelTask } from '../concurrency.js';
import { forgeCommit } from '../git.js';
import { composeCommitMessage } from '../model-tracker.js';

import type { PipelineContext, BuildStageContext } from './types.js';
import { getCompileStage, getBuildStage } from './registry.js';
import { commitPlanArtifacts, hasUnstagedChanges } from './git-helpers.js';
import { createToolTracker } from './span-wiring.js';

const exec = promisify(execFile);

// ---------------------------------------------------------------------------
// Shared review cycle helper (used by both compile and build stages)
// ---------------------------------------------------------------------------

/**
 * Configuration for a review -> evaluate cycle.
 * Used by both compile (plan review) and build (code review) stages.
 */
export interface ReviewCycleConfig {
  tracing: TracingContext;
  cwd: string;
  reviewer: {
    role: AgentRole;
    metadata: Record<string, unknown>;
    run: () => AsyncGenerator<EforgeEvent>;
  };
  evaluator: {
    role: AgentRole;
    metadata: Record<string, unknown>;
    run: (continuationContext?: { attempt: number; maxContinuations: number }) => AsyncGenerator<EforgeEvent>;
  };
}

/**
 * Run a review -> evaluate cycle. The reviewer runs first (non-fatal on error).
 * If the reviewer left unstaged changes, the evaluator runs to accept/reject them.
 * Both phases are traced with Langfuse spans. The evaluator phase delegates
 * continuation handling to `withRetry` using the role-specific policy from
 * `DEFAULT_RETRY_POLICIES`.
 */
export async function* runReviewCycle(config: ReviewCycleConfig): AsyncGenerator<EforgeEvent> {
  // Phase: Review (non-fatal on error)
  const reviewSpan = config.tracing.createSpan(config.reviewer.role, config.reviewer.metadata);
  reviewSpan.setInput(config.reviewer.metadata);
  const reviewTracker = createToolTracker(reviewSpan);
  try {
    for await (const event of config.reviewer.run()) {
      reviewTracker.handleEvent(event);
      yield event;
    }
    reviewTracker.cleanup();
    reviewSpan.end();
  } catch (err) {
    reviewTracker.cleanup();
    reviewSpan.error(err as Error);
    return; // Review failed, skip evaluate
  }

  // Phase: Evaluate (only if reviewer left unstaged changes, non-fatal)
  if (await hasUnstagedChanges(config.cwd)) {
    // Wrap the evaluator.run() callback so it pulls continuationContext out of
    // the retry input. The policy's buildContinuationInput splices it in.
    //
    // The tracing span and tool tracker are created per-attempt (inside this
    // wrapper) so each retry gets its own span and fresh tool-call state.
    const runEvaluatorWrapped = async function* (input: EvaluatorContinuationInput): AsyncGenerator<EforgeEvent> {
      const evalSpan = config.tracing.createSpan(config.evaluator.role, config.evaluator.metadata);
      evalSpan.setInput(config.evaluator.metadata);
      const evalTracker = createToolTracker(evalSpan);
      try {
        const continuationContext = input.evaluatorOptions.evaluatorContinuationContext as { attempt: number; maxContinuations: number } | undefined;
        for await (const event of config.evaluator.run(continuationContext)) {
          evalTracker.handleEvent(event);
          yield event;
        }
        evalTracker.cleanup();
        evalSpan.end();
      } catch (err) {
        evalTracker.cleanup();
        evalSpan.error(err as Error);
        throw err;
      }
    };

    const initialInput: EvaluatorContinuationInput = {
      worktreePath: config.cwd,
      evaluatorOptions: {},
    };

    const evalPolicy = DEFAULT_RETRY_POLICIES[config.evaluator.role] as RetryPolicy<EvaluatorContinuationInput> | undefined;
    if (!evalPolicy) {
      // No policy registered for this role — run without retry.
      try {
        for await (const event of runEvaluatorWrapped(initialInput)) {
          yield event;
        }
      } catch {
        // Wrapper already recorded span error; swallow so evaluate stays non-fatal.
      }
      return;
    }

    try {
      for await (const event of withRetry(runEvaluatorWrapped, evalPolicy, initialInput)) {
        yield event;
      }
    } catch {
      // Per-attempt spans already recorded errors inside the wrapper;
      // swallow so evaluate remains non-fatal.
    }
  }
}

// ---------------------------------------------------------------------------
// Pipeline runners
// ---------------------------------------------------------------------------

/**
 * Run the compile pipeline stages in sequence.
 * Handles the git commit of plan artifacts before the plan-review-cycle stage.
 */
export async function* runCompilePipeline(
  ctx: PipelineContext,
): AsyncGenerator<EforgeEvent> {
  // Index-based iteration: ctx.pipeline may change mid-pipeline (e.g., planner
  // stage switches from excursion to expedition), so re-read ctx.pipeline.compile
  // on each iteration instead of capturing it once via for...of.
  let i = 0;
  let restarts = 0;
  const MAX_RESTARTS = 5;
  while (i < ctx.pipeline.compile.length) {
    const stageName = ctx.pipeline.compile[i];
    if (stageName === 'plan-review-cycle' || stageName === 'architecture-review-cycle') {
      // Commit plan artifacts before running review cycles
      // (reviewers read committed files)
      if (ctx.plans.length > 0 || ctx.expeditionModules.length > 0) {
        const commitCwd = ctx.planCommitCwd ?? ctx.cwd;
        await commitPlanArtifacts(commitCwd, ctx.planSetName, ctx.cwd, ctx.config.plan.outputDir, ctx.modelTracker);
      }
    }
    const stage = getCompileStage(stageName);
    for await (const event of stage(ctx)) {
      if (event.type === 'agent:start') ctx.modelTracker.record(event.model);
      yield event;
    }
    if (ctx.skipped) break;
    // If the stage at our current position is still the one we just ran, it
    // ran to completion — advance past it. This handles composers that shrink
    // or grow the list (e.g. ['planner', 'plan-review-cycle'] → ['planner'])
    // without triggering a re-run of the planner stage.
    //
    // If position i now holds a different stage, the current stage was
    // effectively short-circuited (e.g. plannerStage early-returned when the
    // composer replaced the compile list). Restart from the top of the new list.
    if (ctx.pipeline.compile[i] === stageName) {
      i++;
    } else {
      if (++restarts > MAX_RESTARTS) {
        throw new Error('Compile pipeline restarted too many times — possible infinite loop');
      }
      i = 0;
    }
  }
}

/**
 * Run the build pipeline stages for a single plan.
 * Each entry in the build pipeline is either a single stage name (run sequentially)
 * or an array of stage names (run concurrently via `runParallel`).
 * After a parallel group completes, any uncommitted changes are auto-committed.
 */
export async function* runBuildPipeline(
  ctx: BuildStageContext,
): AsyncGenerator<EforgeEvent> {
  yield { timestamp: new Date().toISOString(), type: 'plan:build:start', planId: ctx.planId };

  for (const spec of ctx.build) {
    if (Array.isArray(spec)) {
      // Parallel group — run all stages concurrently
      const tasks: ParallelTask<EforgeEvent>[] = spec.map((stageName) => {
        const stage = getBuildStage(stageName);
        return {
          id: stageName,
          run: () => stage(ctx),
        };
      });
      for await (const event of runParallel(tasks)) {
        if (event.type === 'agent:start') ctx.modelTracker.record(event.model);
        yield event;
      }

      // After parallel group, commit any uncommitted changes (e.g., from doc-update)
      try {
        const { stdout: statusOut } = await exec('git', ['status', '--porcelain'], { cwd: ctx.worktreePath });
        if (statusOut.trim().length > 0) {
          await exec('git', ['add', '-A'], { cwd: ctx.worktreePath });
          await forgeCommit(ctx.worktreePath, composeCommitMessage(`chore(${ctx.planId}): post-parallel-group auto-commit`, ctx.modelTracker));
        }
      } catch (err) {
        // Non-critical — best-effort commit, but yield a warning so it's observable
        yield { timestamp: new Date().toISOString(), type: 'plan:build:progress', planId: ctx.planId, message: `post-parallel-group auto-commit failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    } else {
      // Sequential stage
      const stage = getBuildStage(spec);
      for await (const event of stage(ctx)) {
        if (event.type === 'agent:start') ctx.modelTracker.record(event.model);
        yield event;
      }
    }

    // Stop pipeline if a stage signaled failure (e.g., implement stage)
    if (ctx.buildFailed) return;
  }

  yield { timestamp: new Date().toISOString(), type: 'plan:build:complete', planId: ctx.planId };
}

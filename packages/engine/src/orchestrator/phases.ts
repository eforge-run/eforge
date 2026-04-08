/**
 * Phase functions for the orchestrator — executePlans, validate, finalize.
 * Each phase is an async generator that yields EforgeEvents.
 * The orchestrator's execute() method calls these in sequence via yield*.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

import type { EforgeEvent, OrchestrationConfig, EforgeState } from '../events.js';
import { saveState } from '../state.js';
import { transitionPlan } from './plan-lifecycle.js';
import { WorktreeManager } from '../worktree-manager.js';
import { Semaphore, AsyncEventQueue } from '../concurrency.js';
import type { PlanRunner, ValidationFixer, PrdValidator, GapCloser } from '../orchestrator.js';
import type { MergeResolver } from '../worktree-ops.js';
import { ATTRIBUTION } from '../git.js';
import { cleanupPlanFiles } from '../cleanup.js';

/**
 * Shared context passed between phase functions.
 * Carries all state and configuration needed by each phase.
 */
export interface PhaseContext {
  state: EforgeState;
  config: OrchestrationConfig;
  stateDir: string;
  repoRoot: string;
  planRunner: PlanRunner;
  parallelism: number;
  signal?: AbortSignal;
  postMergeCommands?: string[];
  validateCommands?: string[];
  validationFixer?: ValidationFixer;
  maxValidationRetries: number;
  mergeResolver?: MergeResolver;
  prdValidator?: PrdValidator;
  gapCloser?: GapCloser;
  minCompletionPercent: number;
  gapClosePerformed: boolean;
  mergeWorktreePath: string;
  featureBranch: string;
  worktreeManager: WorktreeManager;
  /** Tracks plans whose merges failed (accumulated across executePlans) */
  failedMerges: Set<string>;
  /** Tracks recently merged plan IDs for merge resolver context enrichment */
  recentlyMergedIds: string[];
  /** Whether the feature branch was successfully merged to baseBranch */
  featureBranchMerged: boolean;
  /** Whether this execution is resuming from a prior interrupted run */
  resumed: boolean;
  /** Whether to run cleanup on the feature branch before the final merge. */
  shouldCleanup?: boolean;
  /** Plan set name for cleanup commit message. */
  cleanupPlanSet?: string;
  /** Output directory containing plan files. */
  cleanupOutputDir?: string;
  /** Path to the PRD file to remove during cleanup. */
  cleanupPrdFilePath?: string;
}

/**
 * Walk the dependency graph from a failed plan and mark all transitive
 * dependents as blocked. Returns build:failed events for each blocked plan.
 */
export function propagateFailure(
  state: EforgeState,
  failedPlanId: string,
  plans: OrchestrationConfig['plans'],
): EforgeEvent[] {
  const events: EforgeEvent[] = [];

  // Build adjacency: planId → direct dependents
  const dependents = new Map<string, string[]>();
  for (const plan of plans) {
    for (const dep of plan.dependsOn) {
      if (!dependents.has(dep)) dependents.set(dep, []);
      dependents.get(dep)!.push(plan.id);
    }
  }

  // BFS for transitive dependents
  const queue = [failedPlanId];
  const blocked = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const dep of dependents.get(current) ?? []) {
      if (blocked.has(dep)) continue;
      blocked.add(dep);

      const planState = state.plans[dep];
      if (planState && planState.status !== 'completed' && planState.status !== 'merged') {
        transitionPlan(state, dep, 'blocked', { error: `Blocked by failed dependency: ${failedPlanId}` });
        events.push({
          timestamp: new Date().toISOString(),
          type: 'build:failed',
          planId: dep,
          error: `Blocked by failed dependency: ${failedPlanId}`,
        });
      }
      queue.push(dep);
    }
  }

  return events;
}

/**
 * Check if a plan's merge should be skipped because one of its dependencies
 * is in the failedMerges set. Returns null to proceed, or a skip reason string.
 */
export function shouldSkipMerge(
  planId: string,
  plans: OrchestrationConfig['plans'],
  failedMerges: Set<string>,
): string | null {
  const plan = plans.find((p) => p.id === planId);
  if (!plan) return null;

  for (const dep of plan.dependsOn) {
    if (failedMerges.has(dep)) {
      return `Skipped: dependency "${dep}" failed to merge`;
    }
  }

  return null;
}

/**
 * Compute the maximum number of plans that could run concurrently
 * based on the dependency graph's wave structure.
 *
 * Plans are grouped into waves: wave 0 has no dependencies,
 * wave N depends only on plans in waves < N. The max wave size
 * determines the peak concurrency.
 */
export function computeMaxConcurrency(
  plans: OrchestrationConfig['plans'],
): number {
  if (plans.length === 0) return 0;

  // Assign each plan to a wave based on its dependencies
  const waveOf = new Map<string, number>();

  // Iteratively resolve waves — a plan's wave is max(wave of deps) + 1
  // For plans with no deps, wave is 0.
  const planMap = new Map(plans.map((p) => [p.id, p]));

  const resolveWave = (planId: string, visited: Set<string>): number => {
    if (waveOf.has(planId)) return waveOf.get(planId)!;
    if (visited.has(planId)) return 0; // cycle guard
    visited.add(planId);

    const plan = planMap.get(planId);
    if (!plan || plan.dependsOn.length === 0) {
      waveOf.set(planId, 0);
      return 0;
    }

    let maxDepWave = 0;
    for (const dep of plan.dependsOn) {
      maxDepWave = Math.max(maxDepWave, resolveWave(dep, visited));
    }
    const wave = maxDepWave + 1;
    waveOf.set(planId, wave);
    return wave;
  };

  for (const plan of plans) {
    resolveWave(plan.id, new Set());
  }

  // Count plans per wave, return the max (only count actual plans, not phantom deps)
  const waveCounts = new Map<number, number>();
  for (const plan of plans) {
    const wave = waveOf.get(plan.id) ?? 0;
    waveCounts.set(wave, (waveCounts.get(wave) ?? 0) + 1);
  }

  let maxConcurrency = 0;
  for (const count of waveCounts.values()) {
    maxConcurrency = Math.max(maxConcurrency, count);
  }

  return maxConcurrency;
}

/**
 * Execute all plans: greedy scheduling, plan running, merging completed plans.
 * Yields schedule, build, and merge events.
 */
export async function* executePlans(ctx: PhaseContext): AsyncGenerator<EforgeEvent> {
  const { state, config, stateDir, planRunner, signal } = ctx;
  const planMap = new Map(config.plans.map((p) => [p.id, p]));

  // On resume, reconcile persisted state with actual filesystem/git state
  if (ctx.resumed) {
    yield { timestamp: new Date().toISOString(), type: 'reconciliation:start' };
    const report = await ctx.worktreeManager.reconcile(state);
    saveState(stateDir, state);
    yield { timestamp: new Date().toISOString(), type: 'reconciliation:complete', report };
  }

  // Determine if plan worktrees are needed based on dependency graph concurrency
  const maxConcurrency = computeMaxConcurrency(config.plans);
  const needsPlanWorktrees = maxConcurrency > 1;

  const allPlanIds = config.plans.map((p) => p.id);
  yield { timestamp: new Date().toISOString(), type: 'schedule:start', planIds: allPlanIds };

  const semaphore = new Semaphore(ctx.parallelism);
  const eventQueue = new AsyncEventQueue<EforgeEvent>();

  // Track running plans: planId → Promise that resolves when the plan finishes
  const running = new Map<string, Promise<void>>();

  /**
   * Check if a plan is ready to start: pending status and all deps merged.
   */
  const isReady = (planId: string): boolean => {
    const ps = state.plans[planId];
    if (!ps || ps.status !== 'pending') return false;
    return ps.dependsOn.every((dep) => {
      const depState = state.plans[dep];
      return depState && depState.status === 'merged';
    });
  };

  /**
   * Launch a single plan: acquire semaphore, create worktree, run, update state.
   * Pushes events into the shared eventQueue. Returns a promise that resolves
   * when the plan run (and worktree cleanup) is finished.
   */
  const launchPlan = (planId: string): Promise<void> => {
    eventQueue.addProducer();

    const planPromise = (async () => {
      const plan = planMap.get(planId)!;
      let worktreePath: string | undefined;

      try {
        await semaphore.acquire();

        worktreePath = await ctx.worktreeManager.acquireForPlan(planId, plan.branch, needsPlanWorktrees);

        state.plans[planId].worktreePath = worktreePath;
        transitionPlan(state, planId, 'running');
        saveState(stateDir, state);

        // Delegate to injected plan runner
        for await (const event of planRunner(planId, worktreePath, plan)) {
          eventQueue.push(event);
        }

        transitionPlan(state, planId, 'completed');
        saveState(stateDir, state);
      } catch (err) {
        // Handle all failures (worktree creation, plan runner, etc.)
        if (state.plans[planId].status !== 'failed') {
          transitionPlan(state, planId, 'failed', { error: (err as Error).message });
          saveState(stateDir, state);
        }

        // Propagate failure to transitive dependents
        const failureEvents = propagateFailure(state, planId, config.plans);
        saveState(stateDir, state);
        for (const e of failureEvents) eventQueue.push(e);
      } finally {
        semaphore.release();
        await ctx.worktreeManager.releaseForPlan(planId);
        eventQueue.removeProducer();
      }
    })();

    running.set(planId, planPromise);
    return planPromise;
  };

  /**
   * Find all ready plans, emit schedule:ready, and launch them.
   */
  const startReadyPlans = (reason: string): void => {
    for (const planId of allPlanIds) {
      if (running.has(planId)) continue;
      if (!isReady(planId)) continue;

      eventQueue.push({ timestamp: new Date().toISOString(), type: 'schedule:ready', planId, reason });
      launchPlan(planId);
    }
  };

  // Start all zero-dependency plans
  startReadyPlans('no dependencies');

  // Keep the queue alive while the orchestrator is active (plans add/remove
  // themselves as producers; this extra producer prevents premature termination
  // between the last plan finishing and new plans starting).
  eventQueue.addProducer();
  let sentinelActive = true;
  const removeSentinel = () => {
    if (sentinelActive) {
      sentinelActive = false;
      eventQueue.removeProducer();
    }
  };

  // Guard: if no plans were launched (all have unmet dependencies on resume),
  // remove sentinel immediately to avoid hanging.
  if (running.size === 0) {
    removeSentinel();
  }

  // Event-driven loop: yield events in real-time as plan runners push them.
  // After each event, check if any plans completed and process merges inline.
  try {
    for await (const event of eventQueue) {
      if (signal?.aborted) {
        saveState(stateDir, state);
        break;
      }

      yield event;

      // Check if any running plans just finished (completed or failed — NOT pending,
      // which is the initial state before the async plan runner updates it to running)
      const justCompleted: string[] = [];
      for (const [planId] of running) {
        const ps = state.plans[planId];
        if (ps && (ps.status === 'completed' || ps.status === 'failed')) {
          justCompleted.push(planId);
        }
      }

      if (justCompleted.length === 0) continue;

      for (const planId of justCompleted) {
        running.delete(planId);
      }

      // Merge completed plans immediately (serialized — one at a time)
      for (const planId of justCompleted) {
        if (signal?.aborted) break;

        const planState = state.plans[planId];
        if (!planState || planState.status !== 'completed') continue;

        const skipReason = shouldSkipMerge(planId, config.plans, ctx.failedMerges);
        if (skipReason) {
          ctx.failedMerges.add(planId);
          transitionPlan(state, planId, 'failed', { error: skipReason });
          saveState(stateDir, state);
          yield { timestamp: new Date().toISOString(), type: 'build:failed', planId, error: skipReason };

          const failureEvents = propagateFailure(state, planId, config.plans);
          saveState(stateDir, state);
          for (const e of failureEvents) yield e;
          continue;
        }

        yield { timestamp: new Date().toISOString(), type: 'merge:start', planId };

        try {
          const plan = planMap.get(planId)!;

          const commitSha = await ctx.worktreeManager.mergePlan(planId, plan, {
            mode: config.mode,
            mergeResolver: ctx.mergeResolver,
            recentlyMergedIds: ctx.recentlyMergedIds,
            planMap,
          });

          transitionPlan(state, planId, 'merged');
          planState.merged = true;
          ctx.recentlyMergedIds.push(planId);
          saveState(stateDir, state);

          yield { timestamp: new Date().toISOString(), type: 'merge:complete', planId, commitSha };
        } catch (err) {
          ctx.failedMerges.add(planId);
          transitionPlan(state, planId, 'failed', { error: `Merge failed: ${(err as Error).message}` });
          saveState(stateDir, state);

          yield {
            timestamp: new Date().toISOString(),
            type: 'build:failed',
            planId,
            error: `Merge failed: ${(err as Error).message}`,
          };

          // Propagate to transitive dependents
          const failureEvents = propagateFailure(state, planId, config.plans);
          saveState(stateDir, state);
          for (const e of failureEvents) yield e;
        }
      }

      // After merges, check for newly unblocked plans and start them
      if (!signal?.aborted) {
        startReadyPlans('dependencies merged');
      }

      // If no more running plans, terminate the queue
      if (running.size === 0) {
        removeSentinel();
      }
    }
  } finally {
    // Ensure sentinel is removed on abort or unexpected exit
    removeSentinel();
  }
}

/**
 * Run post-merge validation commands with optional fix cycles.
 * Yields validation events. Returns early (without yielding finalize events)
 * if validation fails after all retries.
 */
export async function* validate(ctx: PhaseContext): AsyncGenerator<EforgeEvent> {
  const { state, stateDir, signal, mergeWorktreePath } = ctx;
  const allMerged = Object.values(state.plans).every((p) => p.status === 'merged');
  const { validateCommands, validationFixer } = ctx;
  const maxRetries = ctx.maxValidationRetries;

  // Config postMergeCommands run first (e.g., pnpm install), then planner-generated
  // validate commands (e.g., pnpm type-check, pnpm test). Deduplicate exact matches.
  const allValidationCommands = [
    ...new Set([...(ctx.postMergeCommands ?? []), ...(validateCommands ?? [])]),
  ];

  if (!allMerged || allValidationCommands.length === 0 || signal?.aborted) return;

  // Validation runs in the merge worktree (which already has featureBranch checked out)
  let passed = false;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    yield { timestamp: new Date().toISOString(), type: 'validation:start', commands: allValidationCommands };
    const failures: Array<{ command: string; exitCode: number; output: string }> = [];
    let validationPassed = true;

    for (const cmd of allValidationCommands) {
      if (signal?.aborted) { validationPassed = false; break; }

      yield { timestamp: new Date().toISOString(), type: 'validation:command:start', command: cmd };

      try {
        const { stdout, stderr } = await exec('sh', ['-c', cmd], { cwd: mergeWorktreePath });
        const output = (stdout + stderr).trim();
        yield { timestamp: new Date().toISOString(), type: 'validation:command:complete', command: cmd, exitCode: 0, output };
      } catch (err) {
        const execErr = err as { code?: number | string; stdout?: string; stderr?: string; message?: string };
        const exitCode = typeof execErr.code === 'number' ? execErr.code : 1;
        const stdOutput = (execErr.stdout ?? '') + (execErr.stderr ?? '');
        const output = (stdOutput || (execErr.message ?? '')).trim();
        yield { timestamp: new Date().toISOString(), type: 'validation:command:complete', command: cmd, exitCode, output };
        failures.push({ command: cmd, exitCode, output });
        validationPassed = false;
        break; // Stop on first non-zero exit code
      }
    }

    yield { timestamp: new Date().toISOString(), type: 'validation:complete', passed: validationPassed };

    if (validationPassed) {
      passed = true;
      break;
    }

    // Attempt fix if retries remain and a fixer is available
    if (attempt < maxRetries && validationFixer && !signal?.aborted) {
      for await (const event of validationFixer(mergeWorktreePath, failures, attempt + 1, maxRetries)) {
        yield event;
      }
      // Loop continues to re-validate
    } else {
      break;
    }
  }

  if (!passed) {
    yield { timestamp: new Date().toISOString(), type: 'merge:finalize:skipped', featureBranch: ctx.featureBranch, baseBranch: ctx.config.baseBranch, reason: 'Validation failed' };
    state.status = 'failed';
    state.completedAt = new Date().toISOString();
    saveState(stateDir, state);
  }
}

/**
 * Run PRD validation after post-merge validation passes.
 * Compares the original PRD against the implementation to detect gaps.
 * Agent errors are non-fatal — the build continues if the validator crashes.
 */
export async function* prdValidate(ctx: PhaseContext): AsyncGenerator<EforgeEvent> {
  const { state, stateDir, prdValidator } = ctx;

  if (!prdValidator) return;
  if ((state.status as string) === 'failed') return;

  try {
    for await (const event of prdValidator(ctx.mergeWorktreePath)) {
      yield event;

      // If PRD validation fails, check viability gate before attempting gap closing
      if (event.type === 'prd_validation:complete' && !event.passed) {
        // Viability gate: if completionPercent is defined and below threshold, fail immediately
        if (event.completionPercent !== undefined && event.completionPercent < ctx.minCompletionPercent) {
          yield { timestamp: new Date().toISOString(), type: 'plan:progress', message: `PRD completion ${event.completionPercent}% is below viability threshold (${ctx.minCompletionPercent}%) - skipping gap closing` };
          state.status = 'failed';
          state.completedAt = new Date().toISOString();
          saveState(stateDir, state);
        } else if (ctx.gapCloser && !ctx.gapClosePerformed) {
          try {
            yield* ctx.gapCloser(ctx.mergeWorktreePath, event.gaps, event.completionPercent);
            ctx.gapClosePerformed = true;
          } catch (err) {
            if (err instanceof Error && err.name === 'AbortError') throw err;
            // Gap closer errors are non-fatal — fall through to fail
            state.status = 'failed';
            state.completedAt = new Date().toISOString();
            saveState(stateDir, state);
          }
        } else {
          state.status = 'failed';
          state.completedAt = new Date().toISOString();
          saveState(stateDir, state);
        }
      }
    }
  } catch (err) {
    // Agent errors are non-fatal — PRD validation crashing should not block the build
    if (err instanceof Error && err.name === 'AbortError') throw err;
  }
}

/**
 * Final merge of feature branch to baseBranch and status determination.
 * Yields merge:finalize events.
 */
export async function* finalize(ctx: PhaseContext): AsyncGenerator<EforgeEvent> {
  const { state, config, stateDir, signal, featureBranch } = ctx;
  const allMerged = Object.values(state.plans).every((p) => p.status === 'merged');

  if (allMerged && !signal?.aborted) {
    yield { timestamp: new Date().toISOString(), type: 'merge:finalize:start', featureBranch, baseBranch: config.baseBranch };

    try {
      // Pre-merge dirty tree detection and auto-recovery on repoRoot
      {
        const { stdout: statusOut } = await exec('git', ['status', '--porcelain'], { cwd: ctx.repoRoot });
        const dirtyFiles = statusOut.trim().split('\n').filter(Boolean);
        if (dirtyFiles.length > 0) {
          const preview = dirtyFiles.slice(0, 10).join('\n');
          const suffix = dirtyFiles.length > 10 ? `\n... and ${dirtyFiles.length - 10} more` : '';
          yield { timestamp: new Date().toISOString(), type: 'plan:progress', message: `Dirty working tree detected in repoRoot (${dirtyFiles.length} files). Attempting auto-recovery.\n${preview}${suffix}` };

          // Auto-recover: discard modifications and remove untracked files
          await exec('git', ['checkout', '--', '.'], { cwd: ctx.repoRoot });
          await exec('git', ['clean', '-fd'], { cwd: ctx.repoRoot });

          // Verify recovery succeeded
          const { stdout: statusAfter } = await exec('git', ['status', '--porcelain'], { cwd: ctx.repoRoot });
          const remainingFiles = statusAfter.trim().split('\n').filter(Boolean);
          if (remainingFiles.length > 0) {
            const remainingPreview = remainingFiles.slice(0, 10).join('\n');
            throw new Error(`Failed to clean dirty working tree in repoRoot. Remaining files (${remainingFiles.length}):\n${remainingPreview}`);
          }

          yield { timestamp: new Date().toISOString(), type: 'plan:progress', message: 'Dirty working tree auto-recovery succeeded.' };
        }
      }

      // Run cleanup on the feature branch before the final merge
      if (ctx.shouldCleanup && ctx.cleanupPlanSet && ctx.cleanupOutputDir) {
        try {
          await exec('git', ['checkout', featureBranch], { cwd: ctx.mergeWorktreePath });
          for await (const event of cleanupPlanFiles(ctx.mergeWorktreePath, ctx.cleanupPlanSet, ctx.cleanupOutputDir, ctx.cleanupPrdFilePath)) {
            yield event;
          }
        } catch (cleanupErr) {
          yield { timestamp: new Date().toISOString(), type: 'plan:progress', message: `Feature branch cleanup failed (non-fatal): ${(cleanupErr as Error).message}` };
        }
      }

      // Build the merge commit message
      const prefix = config.mode === 'errand' ? 'fix' : 'feat';
      let commitMessage: string;
      if (config.plans.length === 1) {
        commitMessage = `${prefix}(${config.name}): ${config.plans[0].name}\n\n${ATTRIBUTION}`;
      } else {
        const planList = config.plans.map((p) => `- ${p.id}: ${p.name}`).join('\n');
        commitMessage = `${prefix}(${config.name}): ${config.description}\n\nProfile: ${config.mode}\nPlans:\n${planList}\n\n${ATTRIBUTION}`;
      }
      const commitSha = await ctx.worktreeManager.mergeToBase(config.baseBranch, commitMessage, ctx.mergeResolver);
      ctx.featureBranchMerged = true;
      yield { timestamp: new Date().toISOString(), type: 'merge:finalize:complete', featureBranch, baseBranch: config.baseBranch, commitSha };
    } catch (err) {
      yield { timestamp: new Date().toISOString(), type: 'merge:finalize:skipped', featureBranch, baseBranch: config.baseBranch, reason: `Final merge failed: ${(err as Error).message}` };
      state.status = 'failed';
      state.completedAt = new Date().toISOString();
      saveState(stateDir, state);
      return;
    }
  } else if (!allMerged) {
    // Not all plans merged — skip finalize, leave feature branch for inspection
    yield { timestamp: new Date().toISOString(), type: 'merge:finalize:skipped', featureBranch, baseBranch: config.baseBranch, reason: 'Not all plans merged successfully' };
  } else if (signal?.aborted) {
    // Aborted before finalize — leave feature branch for inspection
    yield { timestamp: new Date().toISOString(), type: 'merge:finalize:skipped', featureBranch, baseBranch: config.baseBranch, reason: 'Aborted before finalize' };
  }

  // Determine final status — only completed if feature branch was merged to baseBranch
  state.status = ctx.featureBranchMerged ? 'completed' : 'failed';
  state.completedAt = new Date().toISOString();
  saveState(stateDir, state);
}

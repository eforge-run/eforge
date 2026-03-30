/**
 * Orchestrator — greedy dependency-driven parallel execution,
 * git worktree lifecycle, and persistent state tracking.
 *
 * Yields EforgeEvents (schedule:start, schedule:ready, merge:start, merge:complete, build:*)
 * as an AsyncGenerator. Agent execution is injected via PlanRunner callbacks.
 */

import { execFile } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { promisify } from 'node:util';

const exec = promisify(execFile);
import type { EforgeEvent, OrchestrationConfig, EforgeState, PlanState } from './events.js';
import { loadState, saveState, updatePlanStatus, isResumable } from './state.js';
import {
  computeWorktreeBase,
  createWorktree,
  removeWorktree,
  mergeWorktree,
  mergeFeatureBranchToBase,
  cleanupWorktrees,
  recoverDriftedWorktree,
  type MergeResolver,
} from './worktree.js';
import { Semaphore, AsyncEventQueue } from './concurrency.js';
import { ATTRIBUTION } from './git.js';

/**
 * Callback that runs a single plan in a worktree.
 * Injected by the consumer to avoid circular dependencies with agent modules.
 */
export type PlanRunner = (
  planId: string,
  worktreePath: string,
  plan: OrchestrationConfig['plans'][0],
) => AsyncGenerator<EforgeEvent>;

/**
 * Callback that attempts to fix validation failures.
 * Injected by the consumer (typically wraps the validation-fixer agent).
 * @param cwd - Working directory where validation runs (merge worktree path)
 */
export type ValidationFixer = (
  cwd: string,
  failures: Array<{ command: string; exitCode: number; output: string }>,
  attempt: number,
  maxAttempts: number,
) => AsyncGenerator<EforgeEvent>;

export interface OrchestratorOptions {
  stateDir: string;
  repoRoot: string;
  planRunner: PlanRunner;
  parallelism?: number;
  signal?: AbortSignal;
  postMergeCommands?: string[];
  validateCommands?: string[];
  validationFixer?: ValidationFixer;
  maxValidationRetries?: number;
  mergeResolver?: MergeResolver;
  /** Path to the merge worktree (created during compile, loaded from state during build). */
  mergeWorktreePath?: string;
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
        updatePlanStatus(state, dep, 'blocked');
        planState.error = `Blocked by failed dependency: ${failedPlanId}`;
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
 * Resume a EforgeState by resetting running plans to pending and
 * re-evaluating blocked plans whose dependencies have resolved.
 */
export function resumeState(state: EforgeState): EforgeState {
  // Reset running plans to pending for re-execution
  for (const [id, plan] of Object.entries(state.plans)) {
    if (plan.status === 'running') {
      updatePlanStatus(state, id, 'pending');
    }
  }
  // Re-evaluate blocked plans — unblock if all deps resolved
  for (const [planId, plan] of Object.entries(state.plans)) {
    if (plan.status === 'blocked') {
      const allDepsResolved = plan.dependsOn.every((dep) => {
        const depState = state.plans[dep];
        return depState && (depState.status === 'completed' || depState.status === 'merged');
      });
      if (allDepsResolved) {
        updatePlanStatus(state, planId, 'pending');
      }
    }
  }
  return state;
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
 * Load existing state or create fresh. On resume, resets running→pending
 * and re-evaluates blocked plans. Non-resumable existing states (failed,
 * completed) fall through to fresh state creation instead of returning stale state.
 */
export function initializeState(
  stateDir: string,
  config: OrchestrationConfig,
  repoRoot: string,
): EforgeState {
  const existing = loadState(stateDir);

  if (existing && existing.setName === config.name) {
    if (isResumable(existing)) {
      resumeState(existing);
      saveState(stateDir, existing);
      return existing;
    }
    // Non-resumable (failed/completed) — fall through to fresh state creation
  }

  // Create fresh state
  const worktreeBase = computeWorktreeBase(repoRoot, config.name);

  const plans: Record<string, PlanState> = {};
  for (const plan of config.plans) {
    plans[plan.id] = {
      status: 'pending',
      branch: plan.branch,
      dependsOn: plan.dependsOn,
      merged: false,
    };
  }

  const state: EforgeState = {
    setName: config.name,
    status: 'running',
    startedAt: new Date().toISOString(),
    baseBranch: config.baseBranch,
    featureBranch: `eforge/${config.name}`,
    worktreeBase,
    // Preserve mergeWorktreePath from preliminary state created during compile
    mergeWorktreePath: existing?.mergeWorktreePath,
    plans,
    completedPlans: [],
  };

  saveState(stateDir, state);
  return state;
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

export class Orchestrator {
  private readonly options: OrchestratorOptions;

  constructor(options: OrchestratorOptions) {
    this.options = options;
  }

  async *execute(config: OrchestrationConfig): AsyncGenerator<EforgeEvent> {
    const { stateDir, repoRoot, planRunner, signal, postMergeCommands } = this.options;
    const parallelism = this.options.parallelism ?? availableParallelism();

    // 1. Load/initialize state
    const state = this.initializeState(config, repoRoot);

    // Non-resumable existing state — emit end and return
    if (state.status !== 'running') {
      yield {
        type: 'phase:end',
        runId: '',
        result: { status: 'failed', summary: `Non-resumable state: ${state.status}` },
        timestamp: new Date().toISOString(),
      };
      return;
    }

    const worktreeBase = state.worktreeBase;
    const planMap = new Map(config.plans.map((p) => [p.id, p]));
    const failedMerges = new Set<string>();
    const featureBranch = state.featureBranch ?? `eforge/${config.name}`;

    // Merge worktree path — provided by compile phase via state, or from options
    const mergeWorktreePath = this.options.mergeWorktreePath ?? state.mergeWorktreePath;
    if (!mergeWorktreePath) {
      throw new Error('mergeWorktreePath is required — it should have been created during compile and persisted in state');
    }

    // Track recently merged plans for merge resolver context enrichment
    const recentlyMergedIds: string[] = [];

    // Track whether the feature branch was successfully merged to baseBranch
    let featureBranchMerged = false;

    // Determine if plan worktrees are needed based on dependency graph concurrency
    const maxConcurrency = computeMaxConcurrency(config.plans);
    const needsPlanWorktrees = maxConcurrency > 1;

    // Track plans that built directly on the merge worktree (no squash merge needed)
    const builtOnMergeWorktree = new Set<string>();

    try {
      // Feature branch was already created by createMergeWorktree() during compile.
      // Verify it exists (should always be the case; if not, something went very wrong).
      try {
        await exec('git', ['rev-parse', '--verify', featureBranch], { cwd: repoRoot });
      } catch {
        throw new Error(`Feature branch '${featureBranch}' not found — it should have been created during compile`);
      }

      // 2. Greedy scheduling loop
      const allPlanIds = config.plans.map((p) => p.id);
      yield { timestamp: new Date().toISOString(), type: 'schedule:start', planIds: allPlanIds };

      const semaphore = new Semaphore(parallelism);
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
          let usedMergeWorktree = false;

          try {
            await semaphore.acquire();

            if (needsPlanWorktrees) {
              // Create worktree — branch off featureBranch (not baseBranch)
              // so plan builders can see committed plan artifacts from compile
              worktreePath = await createWorktree(
                repoRoot,
                worktreeBase,
                plan.branch,
                featureBranch,
              );
            } else {
              // No concurrent plans — build directly on the merge worktree
              worktreePath = mergeWorktreePath;
              usedMergeWorktree = true;
              builtOnMergeWorktree.add(planId);
            }

            state.plans[planId].worktreePath = worktreePath;
            updatePlanStatus(state, planId, 'running');
            saveState(stateDir, state);

            // Delegate to injected plan runner
            for await (const event of planRunner(planId, worktreePath, plan)) {
              eventQueue.push(event);
            }

            updatePlanStatus(state, planId, 'completed');
            saveState(stateDir, state);
          } catch (err) {
            // Handle all failures (worktree creation, plan runner, etc.)
            if (state.plans[planId].status !== 'failed') {
              updatePlanStatus(state, planId, 'failed');
              state.plans[planId].error = (err as Error).message;
              saveState(stateDir, state);
            }

            // Propagate failure to transitive dependents
            const failureEvents = propagateFailure(state, planId, config.plans);
            saveState(stateDir, state);
            for (const e of failureEvents) eventQueue.push(e);
          } finally {
            semaphore.release();
            if (worktreePath && !usedMergeWorktree) {
              try {
                await removeWorktree(repoRoot, worktreePath);
              } catch {
                // Best-effort worktree cleanup
              }
            }
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

      // 3. Start all zero-dependency plans
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

      // 4. Event-driven loop: yield events in real-time as plan runners push them.
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

          // 5. Merge completed plans immediately (serialized — one at a time)
          for (const planId of justCompleted) {
            if (signal?.aborted) break;

            const planState = state.plans[planId];
            if (!planState || planState.status !== 'completed') continue;

            const skipReason = shouldSkipMerge(planId, config.plans, failedMerges);
            if (skipReason) {
              failedMerges.add(planId);
              updatePlanStatus(state, planId, 'failed');
              state.plans[planId].error = skipReason;
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

              if (builtOnMergeWorktree.has(planId)) {
                // Plan built directly on the merge worktree — commits already on featureBranch.
                // No squash merge needed. Recover from any branch drift first, then capture HEAD SHA.
                const prefix = config.mode === 'errand' ? 'fix' : 'feat';
                const driftCommitMessage = `${prefix}(${plan.id}): ${plan.name}\n\n${ATTRIBUTION}`;
                await recoverDriftedWorktree(mergeWorktreePath, featureBranch, driftCommitMessage);

                const { stdout: shaOut } = await exec('git', ['rev-parse', 'HEAD'], { cwd: mergeWorktreePath });
                const commitSha = shaOut.trim();

                updatePlanStatus(state, planId, 'merged');
                planState.merged = true;
                recentlyMergedIds.push(planId);
                saveState(stateDir, state);

                yield { timestamp: new Date().toISOString(), type: 'merge:complete', planId, commitSha };
              } else {
                // Wrap mergeResolver to inject plan context into MergeConflictInfo
                const baseResolver = this.options.mergeResolver;
                const contextResolver: MergeResolver | undefined = baseResolver
                  ? async (cwd, conflict) => {
                      // Enrich conflict info with plan context
                      conflict.planName = plan.name;

                      // Find the most recently merged plan as the likely conflict source
                      if (recentlyMergedIds.length > 0) {
                        const lastMergedId = recentlyMergedIds[recentlyMergedIds.length - 1];
                        const otherPlan = planMap.get(lastMergedId);
                        if (otherPlan) {
                          conflict.otherPlanName = otherPlan.name;
                        }
                      }

                      return baseResolver(cwd, conflict);
                    }
                  : undefined;

                const prefix = config.mode === 'errand' ? 'fix' : 'feat';
                const commitMessage = `${prefix}(${plan.id}): ${plan.name}\n\n${ATTRIBUTION}`;
                // Squash merge into featureBranch in the merge worktree (not repoRoot)
                await mergeWorktree(mergeWorktreePath, plan.branch, featureBranch, commitMessage, contextResolver);

                // Capture the squash-merge commit SHA for diff retrieval
                const { stdout: shaOut } = await exec('git', ['rev-parse', 'HEAD'], { cwd: mergeWorktreePath });
                const commitSha = shaOut.trim();

                // Best-effort branch deletion — squash merges leave branches "unmerged" so use -D (force)
                try {
                  await exec('git', ['branch', '-D', plan.branch], { cwd: repoRoot });
                } catch {
                  // Branch may already be deleted or never created
                }

                updatePlanStatus(state, planId, 'merged');
                planState.merged = true;
                recentlyMergedIds.push(planId);
                saveState(stateDir, state);

                yield { timestamp: new Date().toISOString(), type: 'merge:complete', planId, commitSha };
              }
            } catch (err) {
              failedMerges.add(planId);
              updatePlanStatus(state, planId, 'failed');
              state.plans[planId].error = `Merge failed: ${(err as Error).message}`;
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

          // 6. After merges, check for newly unblocked plans and start them
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

      // 7. Post-merge validation commands (with optional fix cycle)
      const allMerged = Object.values(state.plans).every((p) => p.status === 'merged');
      const { validateCommands, validationFixer } = this.options;
      const maxRetries = this.options.maxValidationRetries ?? 2;

      // Config postMergeCommands run first (e.g., pnpm install), then planner-generated
      // validate commands (e.g., pnpm type-check, pnpm test). Deduplicate exact matches.
      const allValidationCommands = [
        ...new Set([...(postMergeCommands ?? []), ...(validateCommands ?? [])]),
      ];

      if (allMerged && allValidationCommands.length > 0 && !signal?.aborted) {
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
          yield { timestamp: new Date().toISOString(), type: 'merge:finalize:skipped', featureBranch, baseBranch: config.baseBranch, reason: 'Validation failed' };
          state.status = 'failed';
          state.completedAt = new Date().toISOString();
          saveState(stateDir, state);
          return;
        }
      }

      // 8. Final merge of feature branch to baseBranch
      // Uses mergeFeatureBranchToBase() which does ff-only in repoRoot without switching branches
      if (allMerged && !signal?.aborted) {
        yield { timestamp: new Date().toISOString(), type: 'merge:finalize:start', featureBranch, baseBranch: config.baseBranch };

        try {
          const commitSha = await mergeFeatureBranchToBase(repoRoot, featureBranch, config.baseBranch, worktreeBase, this.options.mergeResolver);
          featureBranchMerged = true;
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
      state.status = featureBranchMerged ? 'completed' : 'failed';
      state.completedAt = new Date().toISOString();
      saveState(stateDir, state);
    } finally {
      // 9. Cleanup — always runs, even on errors
      // Note: no `git checkout baseBranch` needed — repoRoot was never modified

      // Remove the merge worktree first (before cleanupWorktrees prunes all)
      if (mergeWorktreePath) {
        try {
          await removeWorktree(repoRoot, mergeWorktreePath);
        } catch {
          // Best-effort merge worktree cleanup
        }
      }

      try {
        await cleanupWorktrees(repoRoot, worktreeBase);
      } catch {
        // Best-effort cleanup
      }

      // Sweep all plan branches (catches failed, skipped, blocked plans that never reached merge)
      for (const [, plan] of planMap) {
        try {
          await exec('git', ['branch', '-D', plan.branch], { cwd: repoRoot });
        } catch {
          // Best-effort — branch may already be deleted or never created
        }
      }

      // Delete feature branch on success; leave for inspection on failure
      if (featureBranchMerged) {
        try {
          await exec('git', ['branch', '-D', featureBranch], { cwd: repoRoot });
        } catch {
          // Best-effort — branch may already be deleted
        }
      }

      saveState(stateDir, state);
    }
  }

  /**
   * Load existing state or create fresh. Delegates to the exported
   * standalone `initializeState` function.
   */
  private initializeState(config: OrchestrationConfig, repoRoot: string): EforgeState {
    return initializeState(this.options.stateDir, config, repoRoot);
  }

}

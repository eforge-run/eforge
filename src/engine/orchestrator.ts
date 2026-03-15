/**
 * Orchestrator — dependency graph resolution, wave-based parallel execution,
 * git worktree lifecycle, and persistent state tracking.
 *
 * Yields EforgeEvents (wave:start, wave:complete, merge:start, merge:complete, build:*)
 * as an AsyncGenerator. Agent execution is injected via PlanRunner callbacks.
 */

import { execFile } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { promisify } from 'node:util';

const exec = promisify(execFile);
import type { EforgeEvent, OrchestrationConfig, EforgeState, PlanState } from './events.js';
import { loadState, saveState, updatePlanStatus, isResumable } from './state.js';
import { resolveDependencyGraph } from './plan.js';
import {
  computeWorktreeBase,
  createWorktree,
  removeWorktree,
  mergeWorktree,
  cleanupWorktrees,
} from './worktree.js';
import { runParallel } from './concurrency.js';
import type { ParallelTask } from './concurrency.js';

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
 */
export type ValidationFixer = (
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

    // 2. Resolve waves (merge happens inline after each wave)
    const { waves } = resolveDependencyGraph(config.plans);
    const planMap = new Map(config.plans.map((p) => [p.id, p]));
    const failedMerges = new Set<string>();

    try {
      // 3. Wave loop
      for (let waveIdx = 0; waveIdx < waves.length; waveIdx++) {
        // Check for abort signal at wave loop entry
        if (signal?.aborted) {
          saveState(stateDir, state);
          break;
        }

        const wave = waves[waveIdx];

        // Filter out completed/blocked/failed plans
        const activePlans = wave.filter((id) => {
          const ps = state.plans[id];
          return (
            ps &&
            ps.status !== 'completed' &&
            ps.status !== 'merged' &&
            ps.status !== 'blocked' &&
            ps.status !== 'failed'
          );
        });

        // Run active plans (skip execution if none need it, but still merge below)
        if (activePlans.length > 0) {
          yield { type: 'wave:start', wave: waveIdx + 1, planIds: activePlans };

          // Build parallel tasks — each wraps worktree lifecycle, plan runner,
          // state updates, and failure propagation into a self-contained generator.
          const tasks: ParallelTask<EforgeEvent>[] = activePlans.map((planId) => ({
            id: planId,
            async *run() {
              const plan = planMap.get(planId)!;
              let worktreePath: string | undefined;

              try {
                // Create worktree
                worktreePath = await createWorktree(
                  repoRoot,
                  worktreeBase,
                  plan.branch,
                  config.baseBranch,
                );

                state.plans[planId].worktreePath = worktreePath;
                updatePlanStatus(state, planId, 'running');
                saveState(stateDir, state);

                // Delegate to injected plan runner
                for await (const event of planRunner(planId, worktreePath, plan)) {
                  yield event;
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
                for (const e of failureEvents) yield e;
              } finally {
                if (worktreePath) {
                  try {
                    await removeWorktree(repoRoot, worktreePath);
                  } catch {
                    // Best-effort worktree cleanup
                  }
                }
              }
            },
          }));

          // Run plans concurrently via runParallel
          for await (const event of runParallel(tasks, { parallelism })) {
            yield event;
          }

          yield { type: 'wave:complete', wave: waveIdx + 1 };
        }

        // 4. Inter-wave merge — merge completed plans from this wave into baseBranch
        // before starting the next wave, so later-wave worktrees see dependency changes.
        for (const planId of wave) {
          if (signal?.aborted) break;

          const planState = state.plans[planId];
          if (!planState || planState.status !== 'completed') continue;

          const skipReason = shouldSkipMerge(planId, config.plans, failedMerges);
          if (skipReason) {
            failedMerges.add(planId);
            updatePlanStatus(state, planId, 'failed');
            state.plans[planId].error = skipReason;
            saveState(stateDir, state);
            yield { type: 'build:failed', planId, error: skipReason };
            continue;
          }

          yield { type: 'merge:start', planId };

          try {
            const plan = planMap.get(planId)!;
            await mergeWorktree(repoRoot, plan.branch, config.baseBranch);

            updatePlanStatus(state, planId, 'merged');
            planState.merged = true;
            saveState(stateDir, state);

            yield { type: 'merge:complete', planId };
          } catch (err) {
            failedMerges.add(planId);
            updatePlanStatus(state, planId, 'failed');
            state.plans[planId].error = `Merge failed: ${(err as Error).message}`;
            saveState(stateDir, state);

            yield {
              type: 'build:failed',
              planId,
              error: `Merge failed: ${(err as Error).message}`,
            };
          }
        }
      }

      // 5. Post-merge validation commands (with optional fix cycle)
      const allMerged = Object.values(state.plans).every((p) => p.status === 'merged');
      const { validateCommands, validationFixer } = this.options;
      const maxRetries = this.options.maxValidationRetries ?? 2;

      // Config postMergeCommands run first (e.g., pnpm install), then planner-generated
      // validate commands (e.g., pnpm type-check, pnpm test). Deduplicate exact matches.
      const allValidationCommands = [
        ...new Set([...(postMergeCommands ?? []), ...(validateCommands ?? [])]),
      ];

      if (allMerged && allValidationCommands.length > 0 && !signal?.aborted) {
        let passed = false;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          yield { type: 'validation:start', commands: allValidationCommands };
          const failures: Array<{ command: string; exitCode: number; output: string }> = [];
          let validationPassed = true;

          for (const cmd of allValidationCommands) {
            if (signal?.aborted) { validationPassed = false; break; }

            yield { type: 'validation:command:start', command: cmd };

            try {
              const { stdout, stderr } = await exec('sh', ['-c', cmd], { cwd: repoRoot });
              const output = (stdout + stderr).trim();
              yield { type: 'validation:command:complete', command: cmd, exitCode: 0, output };
            } catch (err) {
              const execErr = err as { code?: number | string; stdout?: string; stderr?: string; message?: string };
              const exitCode = typeof execErr.code === 'number' ? execErr.code : 1;
              const stdOutput = (execErr.stdout ?? '') + (execErr.stderr ?? '');
              const output = (stdOutput || (execErr.message ?? '')).trim();
              yield { type: 'validation:command:complete', command: cmd, exitCode, output };
              failures.push({ command: cmd, exitCode, output });
              validationPassed = false;
              break; // Stop on first non-zero exit code
            }
          }

          yield { type: 'validation:complete', passed: validationPassed };

          if (validationPassed) {
            passed = true;
            break;
          }

          // Attempt fix if retries remain and a fixer is available
          if (attempt < maxRetries && validationFixer && !signal?.aborted) {
            for await (const event of validationFixer(failures, attempt + 1, maxRetries)) {
              yield event;
            }
            // Loop continues to re-validate
          } else {
            break;
          }
        }

        if (!passed) {
          state.status = 'failed';
          state.completedAt = new Date().toISOString();
          saveState(stateDir, state);
          return;
        }
      }

      // Determine final status
      state.status = allMerged ? 'completed' : 'failed';
      state.completedAt = new Date().toISOString();
      saveState(stateDir, state);
    } finally {
      // 6. Cleanup — always runs, even on errors
      try {
        await cleanupWorktrees(repoRoot, worktreeBase);
      } catch {
        // Best-effort cleanup
      }
      saveState(stateDir, state);
    }
  }

  /**
   * Load existing state or create fresh. On resume, resets running→pending
   * and re-evaluates blocked plans.
   */
  private initializeState(config: OrchestrationConfig, repoRoot: string): EforgeState {
    const { stateDir } = this.options;

    const existing = loadState(stateDir);

    if (existing && existing.setName === config.name) {
      if (isResumable(existing)) {
        resumeState(existing);
        saveState(stateDir, existing);
        return existing;
      }
      // Non-resumable — return as-is (caller checks status)
      return existing;
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
      worktreeBase,
      plans,
      completedPlans: [],
    };

    saveState(stateDir, state);
    return state;
  }

}

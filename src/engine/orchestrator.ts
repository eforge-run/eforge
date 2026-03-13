/**
 * Orchestrator — dependency graph resolution, wave-based parallel execution,
 * git worktree lifecycle, and persistent state tracking.
 *
 * Yields ForgeEvents (wave:start, wave:complete, merge:start, merge:complete, build:*)
 * as an AsyncGenerator. Agent execution is injected via PlanRunner callbacks.
 */

import { availableParallelism } from 'node:os';
import type { ForgeEvent, OrchestrationConfig, ForgeState, PlanState } from './events.js';
import { loadState, saveState, updatePlanStatus, isResumable } from './state.js';
import { resolveDependencyGraph } from './plan.js';
import {
  computeWorktreeBase,
  createWorktree,
  removeWorktree,
  mergeWorktree,
  cleanupWorktrees,
} from './worktree.js';
import { Semaphore, AsyncEventQueue } from './concurrency.js';

/**
 * Callback that runs a single plan in a worktree.
 * Injected by the consumer to avoid circular dependencies with agent modules.
 */
export type PlanRunner = (
  planId: string,
  worktreePath: string,
  plan: OrchestrationConfig['plans'][0],
) => AsyncGenerator<ForgeEvent>;

export interface OrchestratorOptions {
  stateDir: string;
  repoRoot: string;
  planRunner: PlanRunner;
  parallelism?: number;
}

/**
 * Walk the dependency graph from a failed plan and mark all transitive
 * dependents as blocked. Emits build:failed for each blocked plan.
 */
export function propagateFailure(
  state: ForgeState,
  failedPlanId: string,
  plans: OrchestrationConfig['plans'],
  eventQueue: AsyncEventQueue<ForgeEvent>,
): void {
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
        eventQueue.push({
          type: 'build:failed',
          planId: dep,
          error: `Blocked by failed dependency: ${failedPlanId}`,
        });
      }
      queue.push(dep);
    }
  }
}

/**
 * Resume a ForgeState by resetting running plans to pending and
 * re-evaluating blocked plans whose dependencies have resolved.
 */
export function resumeState(state: ForgeState): ForgeState {
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

export class Orchestrator {
  private readonly options: OrchestratorOptions;

  constructor(options: OrchestratorOptions) {
    this.options = options;
  }

  async *execute(config: OrchestrationConfig): AsyncGenerator<ForgeEvent> {
    const { stateDir, repoRoot, planRunner } = this.options;
    const parallelism = this.options.parallelism ?? availableParallelism();

    // 1. Load/initialize state
    const state = this.initializeState(config, repoRoot);

    // Non-resumable existing state — emit end and return
    if (state.status !== 'running') {
      yield {
        type: 'forge:end',
        runId: '',
        result: { status: 'failed', summary: `Non-resumable state: ${state.status}` },
        timestamp: new Date().toISOString(),
      };
      return;
    }

    const worktreeBase = state.worktreeBase;

    // 2. Resolve waves and merge order
    const { waves, mergeOrder } = resolveDependencyGraph(config.plans);
    const planMap = new Map(config.plans.map((p) => [p.id, p]));

    try {
      // 3. Wave loop
      for (let waveIdx = 0; waveIdx < waves.length; waveIdx++) {
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

        if (activePlans.length === 0) continue;

        yield { type: 'wave:start', wave: waveIdx + 1, planIds: activePlans };

        // Run plans concurrently via semaphore + event queue
        const semaphore = new Semaphore(parallelism);
        const eventQueue = new AsyncEventQueue<ForgeEvent>();

        const planPromises = activePlans.map(async (planId) => {
          eventQueue.addProducer();
          let acquired = false;
          try {
            await semaphore.acquire();
            acquired = true;

            const plan = planMap.get(planId)!;

            // Create worktree
            const worktreePath = await createWorktree(
              repoRoot,
              worktreeBase,
              plan.branch,
              config.baseBranch,
            );

            state.plans[planId].worktreePath = worktreePath;
            updatePlanStatus(state, planId, 'running');
            saveState(stateDir, state);

            try {
              // Delegate to injected plan runner
              for await (const event of planRunner(planId, worktreePath, plan)) {
                eventQueue.push(event);
              }

              updatePlanStatus(state, planId, 'completed');
              saveState(stateDir, state);
            } catch (err) {
              updatePlanStatus(state, planId, 'failed');
              state.plans[planId].error = (err as Error).message;
              saveState(stateDir, state);

              // Propagate failure to transitive dependents
              propagateFailure(state, planId, config.plans, eventQueue);
              saveState(stateDir, state);
            } finally {
              try {
                await removeWorktree(repoRoot, worktreePath);
              } catch {
                // Best-effort worktree cleanup
              }
            }
          } catch (err) {
            // Handle errors outside the plan runner (e.g., worktree creation failure)
            if (state.plans[planId].status !== 'failed') {
              updatePlanStatus(state, planId, 'failed');
              state.plans[planId].error = (err as Error).message;
              saveState(stateDir, state);

              propagateFailure(state, planId, config.plans, eventQueue);
              saveState(stateDir, state);
            }
          } finally {
            if (acquired) semaphore.release();
            eventQueue.removeProducer();
          }
        });

        // Consume multiplexed events from all concurrent plans
        for await (const event of eventQueue) {
          yield event;
        }

        // All producers finished — promises should be settled
        await Promise.allSettled(planPromises);

        yield { type: 'wave:complete', wave: waveIdx + 1 };
      }

      // 4. Merge phase — sequential, topological order, --no-ff
      for (const planId of mergeOrder) {
        const planState = state.plans[planId];
        if (!planState || planState.status !== 'completed') continue;

        yield { type: 'merge:start', planId };

        try {
          const plan = planMap.get(planId)!;
          await mergeWorktree(repoRoot, plan.branch, config.baseBranch);

          updatePlanStatus(state, planId, 'merged');
          planState.merged = true;
          saveState(stateDir, state);

          yield { type: 'merge:complete', planId };
        } catch (err) {
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

      // Determine final status
      const allMerged = Object.values(state.plans).every((p) => p.status === 'merged');
      state.status = allMerged ? 'completed' : 'failed';
      state.completedAt = new Date().toISOString();
      saveState(stateDir, state);
    } finally {
      // 5. Cleanup — always runs, even on errors
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
  private initializeState(config: OrchestrationConfig, repoRoot: string): ForgeState {
    const { stateDir } = this.options;

    const existing = loadState(stateDir);

    if (existing) {
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

    const state: ForgeState = {
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

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
import { loadState, saveState, isResumable } from './state.js';
import {
  computeWorktreeBase,
  type MergeResolver,
} from './worktree-ops.js';
import { WorktreeManager } from './worktree-manager.js';
import { executePlans, validate, finalize, type PhaseContext } from './orchestrator/phases.js';
import { resumeState } from './orchestrator/plan-lifecycle.js';

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

export class Orchestrator {
  private readonly options: OrchestratorOptions;

  constructor(options: OrchestratorOptions) {
    this.options = options;
  }

  async *execute(config: OrchestrationConfig): AsyncGenerator<EforgeEvent> {
    const { stateDir, repoRoot, signal } = this.options;
    const state = initializeState(stateDir, config, repoRoot);
    if (state.status !== 'running') {
      yield { type: 'phase:end', runId: '', result: { status: 'failed', summary: `Non-resumable state: ${state.status}` }, timestamp: new Date().toISOString() };
      return;
    }
    const featureBranch = state.featureBranch ?? `eforge/${config.name}`;
    const mergeWorktreePath = this.options.mergeWorktreePath ?? state.mergeWorktreePath;
    if (!mergeWorktreePath) throw new Error('mergeWorktreePath is required — it should have been created during compile and persisted in state');
    try { await exec('git', ['rev-parse', '--verify', featureBranch], { cwd: repoRoot }); } catch { throw new Error(`Feature branch '${featureBranch}' not found — it should have been created during compile`); }
    const wm = new WorktreeManager({ repoRoot, worktreeBase: state.worktreeBase, featureBranch, mergeWorktreePath });
    const planMap = new Map(config.plans.map((p) => [p.id, p]));
    const ctx: PhaseContext = {
      state, config, stateDir, repoRoot, featureBranch, mergeWorktreePath,
      planRunner: this.options.planRunner, parallelism: this.options.parallelism ?? availableParallelism(),
      signal, postMergeCommands: this.options.postMergeCommands, validateCommands: this.options.validateCommands,
      validationFixer: this.options.validationFixer, maxValidationRetries: this.options.maxValidationRetries ?? 2,
      mergeResolver: this.options.mergeResolver, worktreeManager: wm,
      failedMerges: new Set<string>(), recentlyMergedIds: [], featureBranchMerged: false,
    };
    try {
      yield* executePlans(ctx);
      if ((state.status as string) !== 'failed') yield* validate(ctx);
      if ((state.status as string) !== 'failed') yield* finalize(ctx);
    } finally {
      await wm.cleanupAll();
      for (const [, plan] of planMap) { try { await exec('git', ['branch', '-D', plan.branch], { cwd: repoRoot }); } catch { /* best-effort */ } }
      if (ctx.featureBranchMerged) { try { await exec('git', ['branch', '-D', featureBranch], { cwd: repoRoot }); } catch { /* best-effort */ } }
      saveState(stateDir, state);
    }
  }
}

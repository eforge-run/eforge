/**
 * ForgeEngine — the sole public API for plan-build-review workflows.
 * All methods return AsyncGenerator<ForgeEvent> (except status() which is synchronous).
 * Engine emits, consumers render — never writes to stdout.
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import type {
  ForgeEvent,
  ForgeStatus,
  PlanOptions,
  BuildOptions,
  ReviewOptions,
  PlanFile,
  ClarificationQuestion,
} from './events.js';
import type { ForgeConfig } from './config.js';
import type { PlannerOptions } from './agents/planner.js';
import { loadConfig } from './config.js';
import { createTracingContext } from './tracing.js';
import { runPlanner } from './agents/planner.js';
import { builderImplement, builderEvaluate } from './agents/builder.js';
import { runReview } from './agents/reviewer.js';
import { Orchestrator } from './orchestrator.js';
import { parseOrchestrationConfig, parsePlanFile, validatePlanSet } from './plan.js';
import { loadState } from './state.js';

const exec = promisify(execFile);

export interface ForgeEngineOptions {
  /** Working directory (defaults to process.cwd()) */
  cwd?: string;
  /** Config overrides (deep-merged with loaded config) */
  config?: Partial<ForgeConfig>;
  /** Clarification callback for interactive planning */
  onClarification?: (questions: ClarificationQuestion[]) => Promise<Record<string, string>>;
  /** Approval callback for build gates */
  onApproval?: (action: string, details: string) => Promise<boolean>;
}

export class ForgeEngine {
  private readonly config: ForgeConfig;
  private readonly cwd: string;
  private readonly onClarification?: ForgeEngineOptions['onClarification'];
  private readonly onApproval?: ForgeEngineOptions['onApproval'];

  private constructor(config: ForgeConfig, options: ForgeEngineOptions = {}) {
    this.config = config;
    this.cwd = options.cwd ?? process.cwd();
    this.onClarification = options.onClarification;
    this.onApproval = options.onApproval;
  }

  /**
   * Async factory — loads config, applies overrides, returns engine.
   */
  static async create(options: ForgeEngineOptions = {}): Promise<ForgeEngine> {
    const cwd = options.cwd ?? process.cwd();
    let config = await loadConfig(cwd);

    if (options.config) {
      config = mergeConfig(config, options.config);
    }

    return new ForgeEngine(config, options);
  }

  /**
   * Plan: explore codebase, write plan files.
   * Wraps runPlanner() with forge:start/forge:end lifecycle events.
   */
  async *plan(source: string, options: Partial<PlanOptions> = {}): AsyncGenerator<ForgeEvent> {
    const runId = randomUUID();
    const planSet = options.name ?? source;
    const tracing = createTracingContext(this.config, runId, 'plan');

    yield {
      type: 'forge:start',
      runId,
      planSet,
      command: 'plan',
      timestamp: new Date().toISOString(),
    };

    let status: 'completed' | 'failed' = 'completed';
    let summary = 'Planning complete';

    try {
      const span = tracing.createSpan('planner', { source, planSet });

      const plannerOptions: PlannerOptions = {
        ...options,
        cwd: options.cwd ?? this.cwd,
        onClarification: this.onClarification,
      };

      try {
        for await (const event of runPlanner(source, plannerOptions)) {
          yield event;
        }
        span.end();
      } catch (err) {
        status = 'failed';
        summary = (err as Error).message;
        span.error(err as Error);
      }
    } finally {
      yield {
        type: 'forge:end',
        runId,
        result: { status, summary },
        timestamp: new Date().toISOString(),
      };
      await tracing.flush();
    }
  }

  /**
   * Build: validate plan set, orchestrate parallel execution.
   * Creates Orchestrator with PlanRunner closure for three-phase pipeline.
   */
  async *build(planSet: string, options: Partial<BuildOptions> = {}): AsyncGenerator<ForgeEvent> {
    const runId = randomUUID();
    const tracing = createTracingContext(this.config, runId, 'build');
    const cwd = options.cwd ?? this.cwd;

    yield {
      type: 'forge:start',
      runId,
      planSet,
      command: 'build',
      timestamp: new Date().toISOString(),
    };

    let status: 'completed' | 'failed' = 'completed';
    let summary = 'Build complete';

    try {
      // Validate plan set
      const configPath = resolve(cwd, 'plans', planSet, 'orchestration.yaml');
      const validation = await validatePlanSet(configPath);
      if (!validation.valid) {
        status = 'failed';
        summary = `Plan set validation failed: ${validation.errors.join('; ')}`;
        return;
      }

      // Load orchestration config
      const orchConfig = await parseOrchestrationConfig(configPath);

      // Pre-load plan files for the runner
      const planDir = resolve(cwd, 'plans', planSet);
      const planFileMap = new Map<string, PlanFile>();
      for (const plan of orchConfig.plans) {
        const planFile = await parsePlanFile(resolve(planDir, `${plan.id}.md`));
        planFileMap.set(plan.id, planFile);
      }

      // Per-plan runner closure — sequences implement → review → evaluate
      const config = this.config;
      const verbose = options.verbose;

      const planRunner = async function* (
        planId: string,
        worktreePath: string,
      ): AsyncGenerator<ForgeEvent> {
        const planFile = planFileMap.get(planId);
        if (!planFile) {
          yield { type: 'build:failed', planId, error: `Plan file not found: ${planId}` };
          return;
        }

        yield { type: 'build:start', planId };

        // Phase 1: Implement
        const implSpan = tracing.createSpan('builder', { planId, phase: 'implement' });
        let implFailed = false;

        try {
          for await (const event of builderImplement(planFile, { cwd: worktreePath, verbose })) {
            yield event;
            if (event.type === 'build:failed') {
              implFailed = true;
            }
          }
        } catch (err) {
          implSpan.error(err as Error);
          yield { type: 'build:failed', planId, error: (err as Error).message };
          return;
        }

        if (implFailed) {
          implSpan.error('Implementation failed');
          return; // Skip review/evaluate
        }
        implSpan.end();

        // Phase 2: Review
        const reviewSpan = tracing.createSpan('reviewer', { planId });
        try {
          for await (const event of runReview({
            planContent: planFile.body,
            baseBranch: orchConfig.baseBranch,
            planId,
            cwd: worktreePath,
            verbose,
          })) {
            yield event;
          }
          reviewSpan.end();
        } catch (err) {
          // Review failure is non-fatal — implementation preserved
          reviewSpan.error(err as Error);
          yield { type: 'build:complete', planId };
          return;
        }

        // Phase 3: Evaluate (only if reviewer left unstaged changes)
        const hasUnstaged = await hasUnstagedChanges(worktreePath);
        if (hasUnstaged) {
          const evalSpan = tracing.createSpan('evaluator', { planId });
          try {
            for await (const event of builderEvaluate(planFile, { cwd: worktreePath, verbose })) {
              yield event;
            }
            evalSpan.end();
          } catch (err) {
            // Evaluate failure is non-fatal
            evalSpan.error(err as Error);
          }
        }

        yield { type: 'build:complete', planId };
      };

      // Create and run orchestrator
      const parallelism = config.build.parallelism;
      const orchestrator = new Orchestrator({
        stateDir: cwd,
        repoRoot: cwd,
        planRunner,
        parallelism,
      });

      for await (const event of orchestrator.execute(orchConfig)) {
        yield event;
      }
    } catch (err) {
      status = 'failed';
      summary = (err as Error).message;
    } finally {
      yield {
        type: 'forge:end',
        runId,
        result: { status, summary },
        timestamp: new Date().toISOString(),
      };
      await tracing.flush();
    }
  }

  /**
   * Review: run blind review sequentially per plan (no orchestrator).
   */
  async *review(planSet: string, options: Partial<ReviewOptions> = {}): AsyncGenerator<ForgeEvent> {
    const runId = randomUUID();
    const tracing = createTracingContext(this.config, runId, 'review');
    const cwd = options.cwd ?? this.cwd;

    yield {
      type: 'forge:start',
      runId,
      planSet,
      command: 'review',
      timestamp: new Date().toISOString(),
    };

    let status: 'completed' | 'failed' = 'completed';
    let summary = 'Review complete';

    try {
      const configPath = resolve(cwd, 'plans', planSet, 'orchestration.yaml');
      const orchConfig = await parseOrchestrationConfig(configPath);
      const planDir = resolve(cwd, 'plans', planSet);

      for (const plan of orchConfig.plans) {
        const span = tracing.createSpan('reviewer', { planId: plan.id });
        try {
          const planFile = await parsePlanFile(resolve(planDir, `${plan.id}.md`));
          for await (const event of runReview({
            planContent: planFile.body,
            baseBranch: orchConfig.baseBranch,
            planId: plan.id,
            cwd,
            verbose: options.verbose,
          })) {
            yield event;
          }
          span.end();
        } catch (err) {
          // Review failures are non-fatal — continue to next plan
          span.error(err as Error);
        }
      }
    } catch (err) {
      status = 'failed';
      summary = (err as Error).message;
    } finally {
      yield {
        type: 'forge:end',
        runId,
        result: { status, summary },
        timestamp: new Date().toISOString(),
      };
      await tracing.flush();
    }
  }

  /**
   * Status: synchronous state file read.
   */
  status(): ForgeStatus {
    const state = loadState(this.cwd);
    if (!state) {
      return {
        running: false,
        plans: {},
        completedPlans: [],
      };
    }

    const plans: Record<string, ForgeStatus['plans'][string]> = {};
    for (const [id, planState] of Object.entries(state.plans)) {
      plans[id] = planState.status;
    }

    return {
      running: state.status === 'running',
      setName: state.setName,
      plans,
      completedPlans: state.completedPlans,
    };
  }
}

/**
 * Check if there are unstaged changes in a directory.
 */
async function hasUnstagedChanges(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await exec('git', ['diff', '--name-only'], { cwd });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Deep-merge config overrides onto base config.
 */
function mergeConfig(base: ForgeConfig, overrides: Partial<ForgeConfig>): ForgeConfig {
  return {
    langfuse: overrides.langfuse ? { ...base.langfuse, ...overrides.langfuse } : base.langfuse,
    agents: overrides.agents ? { ...base.agents, ...overrides.agents } : base.agents,
    build: overrides.build ? { ...base.build, ...overrides.build } : base.build,
    plan: overrides.plan ? { ...base.plan, ...overrides.plan } : base.plan,
  };
}

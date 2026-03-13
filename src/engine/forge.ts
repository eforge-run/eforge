/**
 * ForgeEngine — the sole public API for plan-build-review workflows.
 * All methods return AsyncGenerator<ForgeEvent> (except status() which is synchronous).
 * Engine emits, consumers render — never writes to stdout.
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
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
  AgentResultData,
  ExpeditionModule,
  OrchestrationConfig,
  ScopeAssessment,
} from './events.js';
import type { ForgeConfig } from './config.js';
import type { PlannerOptions } from './agents/planner.js';
import { loadConfig } from './config.js';
import { createTracingContext, type SpanHandle, type TracingContext } from './tracing.js';
import { runPlanner } from './agents/planner.js';
import { runModulePlanner } from './agents/module-planner.js';
import { builderImplement, builderEvaluate } from './agents/builder.js';
import { runReview } from './agents/reviewer.js';
import { Orchestrator } from './orchestrator.js';
import { parseOrchestrationConfig, parsePlanFile, parseExpeditionIndex, validatePlanSet } from './plan.js';
import { compileExpedition } from './compiler.js';
import { parseModulesBlock } from './agents/common.js';
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

  /** Expose resolved config for CLI diagnostics. */
  get resolvedConfig(): ForgeConfig {
    return this.config;
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
   * Plan: explore codebase, assess scope, write planning artifacts.
   *
   * The planner explores and assesses scope. Based on the assessment:
   * - errand/excursion: planner generates plan files + orchestration.yaml directly
   * - expedition: planner generates architecture.md + index.yaml + module list,
   *   then engine runs module planners and compiles plan files
   */
  async *plan(source: string, options: Partial<PlanOptions> = {}): AsyncGenerator<ForgeEvent> {
    const runId = randomUUID();
    const planSet = options.name ?? source;
    const tracing = createTracingContext(this.config, runId, 'plan', planSet);
    const cwd = options.cwd ?? this.cwd;

    yield {
      type: 'forge:start',
      runId,
      planSet,
      command: 'plan',
      timestamp: new Date().toISOString(),
    };

    let status: 'completed' | 'failed' = 'completed';
    let summary = 'Planning complete';

    tracing.setInput({ source, planSet });

    try {
      // Run planner agent (explores codebase, assesses scope, generates artifacts)
      const span = tracing.createSpan('planner', { source, planSet });
      span.setInput({ source, planSet });

      const plannerOptions: PlannerOptions = {
        ...options,
        cwd,
        onClarification: this.onClarification,
      };

      let scopeAssessment: ScopeAssessment | undefined;
      let expeditionModules: ExpeditionModule[] = [];

      try {
        for await (const event of runPlanner(source, plannerOptions)) {
          // Track scope assessment
          if (event.type === 'plan:scope') {
            scopeAssessment = event.assessment;
          }

          // Detect <modules> block in agent messages (expedition mode, first match only)
          if (event.type === 'agent:message' && event.agent === 'planner' && expeditionModules.length === 0) {
            const modules = parseModulesBlock(event.content);
            if (modules.length > 0) {
              expeditionModules = modules;
              yield { type: 'expedition:architecture:complete', modules };
            }
          }

          if (event.type === 'agent:result' && event.agent === 'planner') {
            populateSpan(span, event.result);
          }

          // Suppress planner's plan:complete in expedition mode (compilation emits the real one)
          if (event.type === 'plan:complete' && scopeAssessment === 'expedition' && expeditionModules.length > 0) {
            continue;
          }

          yield event;
        }
        span.end();

        if (scopeAssessment === 'complete') {
          summary = 'Nothing to plan — source is fully implemented';
        }
      } catch (err) {
        status = 'failed';
        summary = (err as Error).message;
        span.error(err as Error);
      }

      // If expedition scope with modules defined, continue with module planning + compilation
      if (status !== 'failed' && scopeAssessment === 'expedition' && expeditionModules.length > 0) {
        try {
          yield* this.planExpeditionModules(source, expeditionModules, tracing, {
            ...options,
            cwd,
          });
        } catch (err) {
          status = 'failed';
          summary = (err as Error).message;
        }
      }
    } finally {
      tracing.setOutput({ status, summary });
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
   * Run module planners for each expedition module, then compile to plan files.
   */
  private async *planExpeditionModules(
    source: string,
    modules: ExpeditionModule[],
    tracing: TracingContext,
    options: Partial<PlanOptions> & { cwd: string },
  ): AsyncGenerator<ForgeEvent> {
    const planSetName = options.name ?? source;
    const cwd = options.cwd;
    const planDir = resolve(cwd, 'plans', planSetName);

    // Read architecture content for module planners
    let architectureContent = '';
    try {
      architectureContent = await readFile(resolve(planDir, 'architecture.md'), 'utf-8');
    } catch {
      // Architecture file may not exist if planner didn't create it
    }

    // Resolve source content
    let sourceContent: string;
    try {
      const sourcePath = resolve(cwd, source);
      const stats = await stat(sourcePath);
      if (stats.isFile()) {
        sourceContent = await readFile(sourcePath, 'utf-8');
      } else {
        sourceContent = source;
      }
    } catch {
      sourceContent = source;
    }

    // Run module planners sequentially
    for (const mod of modules) {
      const modSpan = tracing.createSpan('module-planner', { moduleId: mod.id });
      modSpan.setInput({ moduleId: mod.id, description: mod.description });

      try {
        for await (const event of runModulePlanner({
          cwd,
          planSetName,
          moduleId: mod.id,
          moduleDescription: mod.description,
          moduleDependsOn: mod.dependsOn,
          architectureContent,
          sourceContent,
          verbose: options.verbose,
          onClarification: this.onClarification,
        })) {
          if (event.type === 'agent:result' && event.agent === 'module-planner') {
            populateSpan(modSpan, event.result);
          }
          yield event;
        }
        modSpan.end();
      } catch (err) {
        // Module planning failure is non-fatal — continue with other modules
        modSpan.error(err as Error);
      }
    }

    // Compile modules into plan files + orchestration.yaml
    yield { type: 'expedition:compile:start' };
    const plans = await compileExpedition(cwd, planSetName);
    yield { type: 'expedition:compile:complete', plans };
    yield { type: 'plan:complete', plans };
  }

  /**
   * Build: validate plan set, orchestrate parallel execution.
   * Creates Orchestrator with PlanRunner closure for three-phase pipeline.
   */
  async *build(planSet: string, options: Partial<BuildOptions> = {}): AsyncGenerator<ForgeEvent> {
    const runId = randomUUID();
    const tracing = createTracingContext(this.config, runId, 'build', planSet);
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

    tracing.setInput({ planSet });

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
        implSpan.setInput({ planId, phase: 'implement' });
        let implFailed = false;

        try {
          for await (const event of builderImplement(planFile, { cwd: worktreePath, verbose })) {
            if (event.type === 'agent:result' && event.agent === 'builder') {
              populateSpan(implSpan, event.result);
            }
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
        reviewSpan.setInput({ planId });
        try {
          for await (const event of runReview({
            planContent: planFile.body,
            baseBranch: orchConfig.baseBranch,
            planId,
            cwd: worktreePath,
            verbose,
          })) {
            if (event.type === 'agent:result' && event.agent === 'reviewer') {
              populateSpan(reviewSpan, event.result);
            }
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
          evalSpan.setInput({ planId });
          try {
            for await (const event of builderEvaluate(planFile, { cwd: worktreePath, verbose })) {
              if (event.type === 'agent:result' && event.agent === 'evaluator') {
                populateSpan(evalSpan, event.result);
              }
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
      tracing.setOutput({ status, summary });
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
    const tracing = createTracingContext(this.config, runId, 'review', planSet);
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

    tracing.setInput({ planSet });

    try {
      const configPath = resolve(cwd, 'plans', planSet, 'orchestration.yaml');
      const orchConfig = await parseOrchestrationConfig(configPath);
      const planDir = resolve(cwd, 'plans', planSet);

      for (const plan of orchConfig.plans) {
        const span = tracing.createSpan('reviewer', { planId: plan.id });
        span.setInput({ planId: plan.id });
        try {
          const planFile = await parsePlanFile(resolve(planDir, `${plan.id}.md`));
          for await (const event of runReview({
            planContent: planFile.body,
            baseBranch: orchConfig.baseBranch,
            planId: plan.id,
            cwd,
            verbose: options.verbose,
          })) {
            if (event.type === 'agent:result' && event.agent === 'reviewer') {
              populateSpan(span, event.result);
            }
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
      tracing.setOutput({ status, summary });
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

/**
 * Populate a Langfuse span/generation with SDK result data.
 */
function populateSpan(span: SpanHandle, data: AgentResultData): void {
  // Set the primary model (first key in modelUsage)
  const models = Object.keys(data.modelUsage);
  if (models.length > 0) {
    span.setModel(models[0]);
  }

  // Set generation output from agent result text
  if (data.resultText) {
    span.setOutput(data.resultText);
  }

  span.setUsage(data.usage);

  // Build detailed usage breakdown from per-model data
  const usageDetails: Record<string, number> = {
    input: data.usage.input,
    output: data.usage.output,
    total: data.usage.total,
  };
  for (const [model, mu] of Object.entries(data.modelUsage)) {
    usageDetails[`${model}:input`] = mu.inputTokens;
    usageDetails[`${model}:output`] = mu.outputTokens;
  }
  span.setUsageDetails(usageDetails);

  span.setCostDetails({
    total: data.totalCostUsd,
    ...Object.fromEntries(
      Object.entries(data.modelUsage).map(([model, mu]) => [model, mu.costUSD]),
    ),
  });
}

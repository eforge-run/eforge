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
  AgentRole,
  ExpeditionModule,
  ScopeAssessment,
} from './events.js';
import type { ForgeConfig } from './config.js';
import type { PlannerOptions } from './agents/planner.js';
import { loadConfig } from './config.js';
import { createTracingContext, type SpanHandle, type ToolCallHandle, type TracingContext } from './tracing.js';
import { runPlanner } from './agents/planner.js';
import { runModulePlanner } from './agents/module-planner.js';
import { builderImplement, builderEvaluate } from './agents/builder.js';
import { runReview } from './agents/reviewer.js';
import { runPlanReview } from './agents/plan-reviewer.js';
import { runPlanEvaluate } from './agents/plan-evaluator.js';
import { Orchestrator } from './orchestrator.js';
import { deriveNameFromSource, parseOrchestrationConfig, parsePlanFile, validatePlanSet, validatePlanSetName } from './plan.js';
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
    const planSetName = options.name ?? deriveNameFromSource(source);
    validatePlanSetName(planSetName);
    const tracing = createTracingContext(this.config, runId, 'plan', planSetName);
    const cwd = options.cwd ?? this.cwd;

    yield {
      type: 'forge:start',
      runId,
      planSet: planSetName,
      command: 'plan',
      timestamp: new Date().toISOString(),
    };

    let status: 'completed' | 'failed' = 'completed';
    let summary = 'Planning complete';

    tracing.setInput({ source, planSet: planSetName });

    // Resolve source content early — needed for plan review + evaluate
    let sourceContent: string;
    try {
      const sourcePath = resolve(cwd, source);
      const stats = await stat(sourcePath);
      sourceContent = stats.isFile() ? await readFile(sourcePath, 'utf-8') : source;
    } catch {
      sourceContent = source;
    }

    try {
      // Run planner agent (explores codebase, assesses scope, generates artifacts)
      const span = tracing.createSpan('planner', { source, planSet: planSetName });
      span.setInput({ source, planSet: planSetName });

      const plannerOptions: PlannerOptions = {
        ...options,
        cwd,
        onClarification: this.onClarification,
      };

      let scopeAssessment: ScopeAssessment | undefined;
      let expeditionModules: ExpeditionModule[] = [];
      let finalPlans: PlanFile[] = [];

      const plannerTracker = createToolTracker(span);
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

          plannerTracker.handleEvent(event);

          // Suppress planner's plan:complete in expedition mode (compilation emits the real one)
          if (event.type === 'plan:complete' && scopeAssessment === 'expedition' && expeditionModules.length > 0) {
            continue;
          }

          // Track final plans for review phase
          if (event.type === 'plan:complete') {
            finalPlans = event.plans;
          }

          yield event;
        }
        plannerTracker.cleanup();
        span.end();

        // No custom summary needed for 'complete' scope — plan:complete
        // already conveys "Nothing to plan" to the display layer.
      } catch (err) {
        plannerTracker.cleanup();
        status = 'failed';
        summary = (err as Error).message;
        span.error(err as Error);
      }

      // If expedition scope with modules defined, continue with module planning + compilation
      if (status !== 'failed' && scopeAssessment === 'expedition' && expeditionModules.length > 0) {
        try {
          for await (const event of this.planExpeditionModules(planSetName, expeditionModules, tracing, {
            ...options,
            cwd,
            sourceContent,
          })) {
            // Track final plans from expedition compilation
            if (event.type === 'plan:complete') {
              finalPlans = event.plans;
            }
            yield event;
          }
        } catch (err) {
          status = 'failed';
          summary = (err as Error).message;
        }
      }

      // Commit plan artifacts (required for worktree-based builds)
      if (status !== 'failed' && finalPlans.length > 0) {
        const planDir = resolve(cwd, 'plans', planSetName);
        const verbose = options.verbose;
        const abortController = options.abortController;

        await exec('git', ['add', planDir], { cwd });
        await exec('git', ['commit', '-m', `plan(${planSetName}): initial planning artifacts`], { cwd });

        // Plan review cycle: blind review → evaluate (non-fatal)
        try {
          yield* runReviewCycle({
            tracing,
            cwd,
            reviewer: {
              role: 'plan-reviewer',
              metadata: { planSet: planSetName },
              run: () => runPlanReview({ sourceContent, planSetName, cwd, verbose, abortController }),
            },
            evaluator: {
              role: 'plan-evaluator',
              metadata: { planSet: planSetName },
              run: () => runPlanEvaluate({ planSetName, sourceContent, cwd, verbose, abortController }),
            },
          });
        } catch (err) {
          // Plan review failure is non-fatal — plan artifacts are already committed
          yield { type: 'plan:progress', message: `Plan review skipped: ${(err as Error).message}` };
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
    planSetName: string,
    modules: ExpeditionModule[],
    tracing: TracingContext,
    options: Partial<PlanOptions> & { cwd: string; sourceContent: string },
  ): AsyncGenerator<ForgeEvent> {
    const cwd = options.cwd;
    const sourceContent = options.sourceContent;
    const planDir = resolve(cwd, 'plans', planSetName);

    // Read architecture content for module planners
    let architectureContent = '';
    try {
      architectureContent = await readFile(resolve(planDir, 'architecture.md'), 'utf-8');
    } catch {
      // Architecture file may not exist if planner didn't create it
    }

    // Run module planners sequentially
    for (const mod of modules) {
      const modSpan = tracing.createSpan('module-planner', { moduleId: mod.id });
      modSpan.setInput({ moduleId: mod.id, description: mod.description });

      const modTracker = createToolTracker(modSpan);
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
          modTracker.handleEvent(event);
          yield event;
        }
        modTracker.cleanup();
        modSpan.end();
      } catch (err) {
        // Module planning failure is non-fatal — continue with other modules
        modTracker.cleanup();
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
    validatePlanSetName(planSet);
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
      const abortController = options.abortController;

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
        const implTracker = createToolTracker(implSpan);
        let implFailed = false;

        try {
          for await (const event of builderImplement(planFile, { cwd: worktreePath, verbose, abortController })) {
            implTracker.handleEvent(event);
            yield event;
            if (event.type === 'build:failed') {
              implFailed = true;
            }
          }
        } catch (err) {
          implTracker.cleanup();
          implSpan.error(err as Error);
          yield { type: 'build:failed', planId, error: (err as Error).message };
          return;
        }

        if (implFailed) {
          implTracker.cleanup();
          implSpan.error('Implementation failed');
          return; // Skip review/evaluate
        }
        implTracker.cleanup();
        implSpan.end();

        // Phase 2 + 3: Review → Evaluate cycle
        yield* runReviewCycle({
          tracing,
          cwd: worktreePath,
          reviewer: {
            role: 'reviewer',
            metadata: { planId },
            run: () => runReview({
              planContent: planFile.body,
              baseBranch: orchConfig.baseBranch,
              planId,
              cwd: worktreePath,
              verbose,
              abortController,
            }),
          },
          evaluator: {
            role: 'evaluator',
            metadata: { planId },
            run: () => builderEvaluate(planFile, { cwd: worktreePath, verbose, abortController }),
          },
        });

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
    validatePlanSetName(planSet);
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
        const tracker = createToolTracker(span);
        try {
          const planFile = await parsePlanFile(resolve(planDir, `${plan.id}.md`));
          for await (const event of runReview({
            planContent: planFile.body,
            baseBranch: orchConfig.baseBranch,
            planId: plan.id,
            cwd,
            verbose: options.verbose,
            abortController: options.abortController,
          })) {
            tracker.handleEvent(event);
            yield event;
          }
          tracker.cleanup();
          span.end();
        } catch (err) {
          // Review failures are non-fatal — continue to next plan
          tracker.cleanup();
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
 * Configuration for a review → evaluate cycle.
 * Used by both plan() (plan review) and build() (code review).
 */
interface ReviewCycleConfig {
  tracing: TracingContext;
  cwd: string;
  reviewer: {
    role: AgentRole;
    metadata: Record<string, unknown>;
    run: () => AsyncGenerator<ForgeEvent>;
  };
  evaluator: {
    role: AgentRole;
    metadata: Record<string, unknown>;
    run: () => AsyncGenerator<ForgeEvent>;
  };
}

/**
 * Run a review → evaluate cycle. The reviewer runs first (non-fatal on error).
 * If the reviewer left unstaged changes, the evaluator runs to accept/reject them.
 * Both phases are traced with Langfuse spans.
 */
async function* runReviewCycle(config: ReviewCycleConfig): AsyncGenerator<ForgeEvent> {
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
    const evalSpan = config.tracing.createSpan(config.evaluator.role, config.evaluator.metadata);
    evalSpan.setInput(config.evaluator.metadata);
    const evalTracker = createToolTracker(evalSpan);
    try {
      for await (const event of config.evaluator.run()) {
        evalTracker.handleEvent(event);
        yield event;
      }
      evalTracker.cleanup();
      evalSpan.end();
    } catch (err) {
      evalTracker.cleanup();
      evalSpan.error(err as Error);
    }
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
 * Create a tool call tracker for a span.
 * Intercepts tool_use/tool_result/result events and manages Langfuse sub-spans.
 */
function createToolTracker(span: SpanHandle) {
  const activeTools = new Map<string, ToolCallHandle>();

  return {
    handleEvent(event: ForgeEvent): void {
      if (event.type === 'agent:tool_use') {
        const handle = span.addToolCall(event.toolUseId, event.tool, event.input);
        activeTools.set(event.toolUseId, handle);
      }
      if (event.type === 'agent:tool_result') {
        const handle = activeTools.get(event.toolUseId);
        if (handle) {
          handle.end(event.output);
          activeTools.delete(event.toolUseId);
        }
      }
      if (event.type === 'agent:result') {
        populateSpan(span, event.result);
      }
    },
    cleanup(): void {
      for (const [, handle] of activeTools) {
        handle.end();
      }
      activeTools.clear();
    },
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

  // Capture duration and turn count as metadata
  span.setMetadata({
    durationMs: data.durationMs,
    durationApiMs: data.durationApiMs,
    numTurns: data.numTurns,
  });
}

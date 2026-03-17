/**
 * Pipeline — named stages with a uniform interface, driven by resolved profiles.
 *
 * Pipeline stages are named units: each accepts a context and yields EforgeEvents.
 * The engine iterates the stage list from the resolved profile and calls each stage
 * in sequence. Profile selection is a pre-pipeline step handled by the engine.
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import type {
  EforgeEvent,
  AgentRole,
  AgentResultData,
  PlanFile,
  ClarificationQuestion,
  ExpeditionModule,
  ScopeAssessment,
  ReviewIssue,
  OrchestrationConfig,
} from './events.js';
import type { EforgeConfig, ResolvedProfileConfig } from './config.js';
import type { AgentBackend } from './backend.js';
import type { TracingContext, SpanHandle, ToolCallHandle } from './tracing.js';
import { runPlanner } from './agents/planner.js';
import { runModulePlanner } from './agents/module-planner.js';
import { builderImplement, builderEvaluate } from './agents/builder.js';
import { runParallelReview } from './agents/parallel-reviewer.js';
import { runReviewFixer } from './agents/review-fixer.js';
import { runPlanReview } from './agents/plan-reviewer.js';
import { runPlanEvaluate } from './agents/plan-evaluator.js';
import { runCohesionReview } from './agents/cohesion-reviewer.js';
import { runCohesionEvaluate } from './agents/cohesion-evaluator.js';
import { parseModulesBlock } from './agents/common.js';
import { compileExpedition } from './compiler.js';
import { resolveDependencyGraph } from './plan.js';
import { runParallel, type ParallelTask } from './concurrency.js';

const exec = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PipelineContext {
  backend: AgentBackend;
  config: EforgeConfig;
  profile: ResolvedProfileConfig;
  tracing: TracingContext;
  cwd: string;
  planSetName: string;
  sourceContent: string;
  verbose?: boolean;
  auto?: boolean;
  abortController?: AbortController;
  onClarification?: (questions: ClarificationQuestion[]) => Promise<Record<string, string>>;

  // Mutable state passed between stages
  plans: PlanFile[];
  scopeAssessment?: ScopeAssessment;
  expeditionModules: ExpeditionModule[];
}

/** Context for build stages, extends PipelineContext with per-plan fields. */
export interface BuildStageContext extends PipelineContext {
  planId: string;
  worktreePath: string;
  planFile: PlanFile;
  orchConfig: OrchestrationConfig;
  reviewIssues: ReviewIssue[];
  /** Set to true by the implement stage on failure — signals the pipeline runner to stop. */
  buildFailed?: boolean;
}

export type CompileStage = (ctx: PipelineContext) => AsyncGenerator<EforgeEvent>;
export type BuildStage = (ctx: BuildStageContext) => AsyncGenerator<EforgeEvent>;

// ---------------------------------------------------------------------------
// Stage Registry
// ---------------------------------------------------------------------------

const compileStages = new Map<string, CompileStage>();
const buildStages = new Map<string, BuildStage>();

export function registerCompileStage(name: string, stage: CompileStage): void {
  compileStages.set(name, stage);
}

export function registerBuildStage(name: string, stage: BuildStage): void {
  buildStages.set(name, stage);
}

export function getCompileStage(name: string): CompileStage {
  const stage = compileStages.get(name);
  if (!stage) throw new Error(`Unknown compile stage: "${name}"`);
  return stage;
}

export function getBuildStage(name: string): BuildStage {
  const stage = buildStages.get(name);
  if (!stage) throw new Error(`Unknown build stage: "${name}"`);
  return stage;
}

// ---------------------------------------------------------------------------
// Helpers (extracted from eforge.ts)
// ---------------------------------------------------------------------------

/**
 * Create a tool call tracker for a span.
 * Intercepts tool_use/tool_result/result events and manages Langfuse sub-spans.
 */
export function createToolTracker(span: SpanHandle) {
  const activeTools = new Map<string, ToolCallHandle>();

  return {
    handleEvent(event: EforgeEvent): void {
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
export function populateSpan(span: SpanHandle, data: AgentResultData): void {
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

/**
 * Check if there are unstaged changes in a directory.
 */
export async function hasUnstagedChanges(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await exec('git', ['diff', '--name-only'], { cwd });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Read maxTurns from profile for a given agent role, with fallback to global config.
 */
export function getAgentMaxTurns(
  profile: ResolvedProfileConfig,
  role: AgentRole,
  config: EforgeConfig,
): number {
  return profile.agents[role]?.maxTurns ?? config.agents.maxTurns;
}

// ---------------------------------------------------------------------------
// Issue severity filtering
// ---------------------------------------------------------------------------

const SEVERITY_ORDER: Record<ReviewIssue['severity'], number> = {
  critical: 0,
  warning: 1,
  suggestion: 2,
};

/**
 * Filter review issues by severity threshold.
 * `autoAcceptBelow: 'warning'` means issues at warning and below (warning, suggestion)
 * are auto-accepted. Only critical issues reach the fixer.
 * `autoAcceptBelow: 'suggestion'` means only suggestion-severity issues are auto-accepted.
 * Critical and warning reach the fixer.
 */
export function filterIssuesBySeverity(
  issues: ReviewIssue[],
  autoAcceptBelow?: 'suggestion' | 'warning',
): { filtered: ReviewIssue[]; autoAccepted: ReviewIssue[] } {
  if (!autoAcceptBelow) return { filtered: issues, autoAccepted: [] };
  const threshold = SEVERITY_ORDER[autoAcceptBelow];
  const filtered = issues.filter(i => SEVERITY_ORDER[i.severity] < threshold);
  const autoAccepted = issues.filter(i => SEVERITY_ORDER[i.severity] >= threshold);
  return { filtered, autoAccepted };
}

// ---------------------------------------------------------------------------
// Built-in Compile Stages
// ---------------------------------------------------------------------------

registerCompileStage('planner', async function* plannerStage(ctx) {
  const agentConfig = ctx.profile.agents.planner;
  const span = ctx.tracing.createSpan('planner', { source: ctx.sourceContent, planSet: ctx.planSetName });
  span.setInput({ source: ctx.sourceContent, planSet: ctx.planSetName });
  const tracker = createToolTracker(span);

  try {
    for await (const event of runPlanner(ctx.sourceContent, {
      cwd: ctx.cwd,
      name: ctx.planSetName,
      auto: ctx.auto,
      verbose: ctx.verbose,
      abortController: ctx.abortController,
      backend: ctx.backend,
      onClarification: ctx.onClarification,
      profiles: ctx.config.profiles,
      ...(agentConfig?.maxTurns && { maxTurns: agentConfig.maxTurns }),
    })) {
      // Track scope assessment
      if (event.type === 'plan:scope') {
        ctx.scopeAssessment = event.assessment;
      }

      // Update active profile when planner selects one.
      // Prefer inline config (future: agent-generated profiles), fall back to named lookup.
      if (event.type === 'plan:profile') {
        if (event.config) {
          ctx.profile = event.config;
        } else {
          const resolved = ctx.config.profiles[event.profileName];
          if (resolved) {
            ctx.profile = resolved;
          } else {
            throw new Error(`Planner selected unknown profile "${event.profileName}" — available profiles: ${Object.keys(ctx.config.profiles).join(', ')}`);
          }
        }
      }

      // Detect <modules> block in agent messages (expedition mode, first match only)
      if (event.type === 'agent:message' && event.agent === 'planner' && ctx.expeditionModules.length === 0) {
        const modules = parseModulesBlock(event.content);
        if (modules.length > 0) {
          ctx.expeditionModules = modules;
          yield { type: 'expedition:architecture:complete', modules };
        }
      }

      tracker.handleEvent(event);

      // Suppress planner's plan:complete in expedition mode (compilation emits the real one)
      if (event.type === 'plan:complete' && ctx.scopeAssessment === 'expedition' && ctx.expeditionModules.length > 0) {
        continue;
      }

      // Track final plans for review phase
      if (event.type === 'plan:complete') {
        ctx.plans = event.plans;
      }

      yield event;
    }
    tracker.cleanup();
    span.end();
  } catch (err) {
    tracker.cleanup();
    span.error(err as Error);
    throw err;
  }
});

registerCompileStage('plan-review-cycle', async function* planReviewCycleStage(ctx) {
  const verbose = ctx.verbose;
  const abortController = ctx.abortController;

  try {
    yield* runReviewCycle({
      tracing: ctx.tracing,
      cwd: ctx.cwd,
      reviewer: {
        role: 'plan-reviewer',
        metadata: { planSet: ctx.planSetName },
        run: () => runPlanReview({
          backend: ctx.backend,
          sourceContent: ctx.sourceContent,
          planSetName: ctx.planSetName,
          cwd: ctx.cwd,
          verbose,
          abortController,
        }),
      },
      evaluator: {
        role: 'plan-evaluator',
        metadata: { planSet: ctx.planSetName },
        run: () => runPlanEvaluate({
          backend: ctx.backend,
          planSetName: ctx.planSetName,
          sourceContent: ctx.sourceContent,
          cwd: ctx.cwd,
          verbose,
          abortController,
        }),
      },
    });
  } catch (err) {
    // Plan review failure is non-fatal - plan artifacts are already committed
    yield { type: 'plan:progress', message: `Plan review skipped: ${(err as Error).message}` };
  }
});

registerCompileStage('module-planning', async function* modulePlanningStage(ctx) {
  // Only runs when expedition modules are detected
  if (ctx.expeditionModules.length === 0) return;

  const cwd = ctx.cwd;
  const planDir = resolve(cwd, 'plans', ctx.planSetName);

  // Read architecture content for module planners
  let architectureContent = '';
  try {
    architectureContent = await readFile(resolve(planDir, 'architecture.md'), 'utf-8');
  } catch {
    // Architecture file may not exist if planner didn't create it
  }

  // 1. Compute dependency waves via topological sort
  const plansForGraph = ctx.expeditionModules.map((mod) => ({
    id: mod.id,
    name: mod.id,
    dependsOn: mod.dependsOn,
    branch: mod.id,
  }));
  const { waves } = resolveDependencyGraph(plansForGraph);
  const moduleMap = new Map(ctx.expeditionModules.map((m) => [m.id, m]));
  const completedPlans = new Map<string, string>(); // moduleId -> plan file content

  const backend = ctx.backend;
  const onClarification = ctx.onClarification;
  const verbose = ctx.verbose;
  const abortController = ctx.abortController;
  const tracing = ctx.tracing;
  const sourceContent = ctx.sourceContent;
  const planSetName = ctx.planSetName;
  const agentConfig = ctx.profile.agents['module-planner'];

  // 2. Plan each wave (parallel within wave, sequential across waves)
  for (let waveIdx = 0; waveIdx < waves.length; waveIdx++) {
    const waveModuleIds = waves[waveIdx];
    yield { type: 'expedition:wave:start', wave: waveIdx + 1, moduleIds: waveModuleIds };

    const waveTasks: ParallelTask<EforgeEvent>[] = waveModuleIds.map((modId) => {
      const mod = moduleMap.get(modId)!;

      // Gather completed dependency plan content from earlier waves
      const depContent = mod.dependsOn
        .map((depId) => completedPlans.get(depId))
        .filter((c): c is string => c !== undefined);
      const dependencyPlanContent = depContent.length > 0
        ? depContent.join('\n\n---\n\n')
        : undefined;

      return {
        id: mod.id,
        run: async function* () {
          const modSpan = tracing.createSpan('module-planner', { moduleId: mod.id });
          modSpan.setInput({ moduleId: mod.id, description: mod.description });

          const modTracker = createToolTracker(modSpan);
          try {
            for await (const event of runModulePlanner({
              backend,
              cwd,
              planSetName,
              moduleId: mod.id,
              moduleDescription: mod.description,
              moduleDependsOn: mod.dependsOn,
              architectureContent,
              sourceContent,
              dependencyPlanContent,
              verbose,
              onClarification,
              abortController,
              ...(agentConfig?.maxTurns && { maxTurns: agentConfig.maxTurns }),
            })) {
              modTracker.handleEvent(event);
              yield event;
            }
            modTracker.cleanup();
            modSpan.end();
          } catch (err) {
            // Module planning failure is non-fatal - continue with other modules
            modTracker.cleanup();
            modSpan.error(err as Error);
          }
        },
      };
    });

    yield* runParallel(waveTasks);

    // Read completed module plan files for this wave (context for later waves)
    for (const modId of waveModuleIds) {
      try {
        const content = await readFile(resolve(planDir, 'modules', `${modId}.md`), 'utf-8');
        completedPlans.set(modId, content);
      } catch {
        // Module planner may have failed - skip
      }
    }

    yield { type: 'expedition:wave:complete', wave: waveIdx + 1 };
  }
});

registerCompileStage('cohesion-review-cycle', async function* cohesionReviewCycleStage(ctx) {
  // Only meaningful in expedition mode
  if (ctx.expeditionModules.length === 0) return;

  const cwd = ctx.cwd;
  const planDir = resolve(cwd, 'plans', ctx.planSetName);
  const verbose = ctx.verbose;
  const abortController = ctx.abortController;
  const backend = ctx.backend;
  const sourceContent = ctx.sourceContent;
  const planSetName = ctx.planSetName;

  // Read architecture content for cohesion review
  let architectureContent = '';
  try {
    architectureContent = await readFile(resolve(planDir, 'architecture.md'), 'utf-8');
  } catch {
    // Architecture file may not exist
  }

  try {
    yield* runReviewCycle({
      tracing: ctx.tracing,
      cwd,
      reviewer: {
        role: 'cohesion-reviewer',
        metadata: { planSet: planSetName },
        run: () => runCohesionReview({ backend, sourceContent, planSetName, architectureContent, cwd, verbose, abortController }),
      },
      evaluator: {
        role: 'cohesion-evaluator',
        metadata: { planSet: planSetName },
        run: () => runCohesionEvaluate({ backend, planSetName, sourceContent, cwd, verbose, abortController }),
      },
    });
  } catch (err) {
    yield { type: 'plan:progress', message: `Cohesion review skipped: ${(err as Error).message}` };
  }
});

registerCompileStage('compile-expedition', async function* compileExpeditionStage(ctx) {
  // Only runs when expedition modules are detected
  if (ctx.expeditionModules.length === 0) return;

  yield { type: 'expedition:compile:start' };
  const plans = await compileExpedition(ctx.cwd, ctx.planSetName);
  yield { type: 'expedition:compile:complete', plans };
  yield { type: 'plan:complete', plans };

  // Update context plans for downstream stages
  ctx.plans = plans;
});

// ---------------------------------------------------------------------------
// Built-in Build Stages
// ---------------------------------------------------------------------------

registerBuildStage('implement', async function* implementStage(ctx) {
  const maxTurns = getAgentMaxTurns(ctx.profile, 'builder', ctx.config);

  const implSpan = ctx.tracing.createSpan('builder', { planId: ctx.planId, phase: 'implement' });
  implSpan.setInput({ planId: ctx.planId, phase: 'implement' });
  const implTracker = createToolTracker(implSpan);
  let implFailed = false;

  try {
    for await (const event of builderImplement(ctx.planFile, {
      backend: ctx.backend,
      cwd: ctx.worktreePath,
      verbose: ctx.verbose,
      abortController: ctx.abortController,
      maxTurns,
    })) {
      implTracker.handleEvent(event);
      yield event;
      if (event.type === 'build:failed') {
        implFailed = true;
      }
    }
  } catch (err) {
    implTracker.cleanup();
    implSpan.error(err as Error);
    yield { type: 'build:failed', planId: ctx.planId, error: (err as Error).message };
    ctx.buildFailed = true;
    return;
  }

  if (implFailed) {
    implTracker.cleanup();
    implSpan.error('Implementation failed');
    ctx.buildFailed = true;
    return; // Skip remaining stages
  }
  implTracker.cleanup();
  implSpan.end();

  // Emit files changed by implementation (non-critical)
  try {
    const { stdout } = await exec('git', ['diff', '--name-only', `${ctx.orchConfig.baseBranch}...HEAD`], { cwd: ctx.worktreePath });
    const files = stdout.trim().split('\n').filter(Boolean);
    if (files.length > 0) {
      yield { type: 'build:files_changed', planId: ctx.planId, files };
    }
  } catch {
    // Non-critical - skip silently
  }
});

registerBuildStage('review', async function* reviewStage(ctx) {
  yield* reviewStageInner(ctx);
});

async function* reviewStageInner(
  ctx: BuildStageContext,
  overrides?: { strategy?: 'auto' | 'single' | 'parallel'; perspectives?: string[] },
): AsyncGenerator<EforgeEvent> {
  const strategy = overrides?.strategy ?? ctx.profile.review.strategy;
  const perspectives = overrides?.perspectives ?? (ctx.profile.review.perspectives.length > 0 ? ctx.profile.review.perspectives : undefined);

  const reviewSpan = ctx.tracing.createSpan('reviewer', { planId: ctx.planId, phase: 'review' });
  reviewSpan.setInput({ planId: ctx.planId, phase: 'review' });
  const reviewTracker = createToolTracker(reviewSpan);

  try {
    for await (const event of runParallelReview({
      backend: ctx.backend,
      planContent: ctx.planFile.body,
      baseBranch: ctx.orchConfig.baseBranch,
      planId: ctx.planId,
      cwd: ctx.worktreePath,
      verbose: ctx.verbose,
      abortController: ctx.abortController,
      strategy,
      perspectives,
    })) {
      reviewTracker.handleEvent(event);
      yield event;
      if (event.type === 'build:review:complete') {
        ctx.reviewIssues = event.issues;
      }
    }
    reviewTracker.cleanup();
    reviewSpan.end();
  } catch (err) {
    reviewTracker.cleanup();
    reviewSpan.error(err as Error);
  }
}

registerBuildStage('review-fix', async function* reviewFixStage(ctx) {
  yield* reviewFixStageInner(ctx);
});

async function* reviewFixStageInner(ctx: BuildStageContext): AsyncGenerator<EforgeEvent> {
  // Filter issues by autoAcceptBelow threshold
  const { filtered, autoAccepted } = filterIssuesBySeverity(
    ctx.reviewIssues,
    ctx.profile.review.autoAcceptBelow,
  );
  ctx.reviewIssues = filtered;

  // Only runs if review found actionable issues after filtering
  if (ctx.reviewIssues.length === 0) return;

  const fixerSpan = ctx.tracing.createSpan('review-fixer', { planId: ctx.planId });
  fixerSpan.setInput({
    planId: ctx.planId,
    issueCount: ctx.reviewIssues.length,
    autoAccepted: autoAccepted.length,
  });
  const fixerTracker = createToolTracker(fixerSpan);

  try {
    for await (const event of runReviewFixer({
      backend: ctx.backend,
      planId: ctx.planId,
      cwd: ctx.worktreePath,
      issues: ctx.reviewIssues,
      verbose: ctx.verbose,
      abortController: ctx.abortController,
    })) {
      fixerTracker.handleEvent(event);
      yield event;
    }
    fixerTracker.cleanup();
    fixerSpan.end();
  } catch (err) {
    fixerTracker.cleanup();
    fixerSpan.error(err as Error);
  }
}

registerBuildStage('evaluate', async function* evaluateStage(ctx) {
  yield* evaluateStageInner(ctx);
});

async function* evaluateStageInner(
  ctx: BuildStageContext,
  overrides?: { strictness?: 'strict' | 'standard' | 'lenient' },
): AsyncGenerator<EforgeEvent> {
  // Only runs if there are unstaged changes from review/fixer
  if (!(await hasUnstagedChanges(ctx.worktreePath))) return;

  const strictness = overrides?.strictness ?? ctx.profile.review.evaluatorStrictness;

  const evalSpan = ctx.tracing.createSpan('evaluator', { planId: ctx.planId });
  evalSpan.setInput({ planId: ctx.planId });
  const evalTracker = createToolTracker(evalSpan);

  try {
    for await (const event of builderEvaluate(ctx.planFile, {
      backend: ctx.backend,
      cwd: ctx.worktreePath,
      verbose: ctx.verbose,
      abortController: ctx.abortController,
      strictness,
    })) {
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

registerBuildStage('review-cycle', async function* reviewCycleStage(ctx) {
  const maxRounds = ctx.profile.review.maxRounds;
  const strategy = ctx.profile.review.strategy;
  const perspectives = ctx.profile.review.perspectives.length > 0 ? ctx.profile.review.perspectives : undefined;
  const autoAcceptBelow = ctx.profile.review.autoAcceptBelow;
  const strictness = ctx.profile.review.evaluatorStrictness;

  for (let round = 0; round < maxRounds; round++) {
    // 1. Review
    yield* reviewStageInner(ctx, { strategy, perspectives });

    // 2. Filter issues
    const { filtered } = filterIssuesBySeverity(ctx.reviewIssues, autoAcceptBelow);
    ctx.reviewIssues = filtered;

    if (filtered.length === 0) break; // No actionable issues

    // 3. Review-fix
    yield* reviewFixStageInner(ctx);

    // 4. Evaluate
    yield* evaluateStageInner(ctx, { strictness });
  }
});

registerBuildStage('validate', async function* validateStage(_ctx) {
  // Placeholder for inline validation (not used in default profiles).
  // Post-merge validation continues to be handled by the Orchestrator.
  // Custom profiles can include this stage for inline validation.
});

// ---------------------------------------------------------------------------
// Review Cycle (shared helper)
// ---------------------------------------------------------------------------

/**
 * Configuration for a review -> evaluate cycle.
 * Used by both compile (plan review) and build (code review) stages.
 */
interface ReviewCycleConfig {
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
    run: () => AsyncGenerator<EforgeEvent>;
  };
}

/**
 * Run a review -> evaluate cycle. The reviewer runs first (non-fatal on error).
 * If the reviewer left unstaged changes, the evaluator runs to accept/reject them.
 * Both phases are traced with Langfuse spans.
 */
async function* runReviewCycle(config: ReviewCycleConfig): AsyncGenerator<EforgeEvent> {
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

// ---------------------------------------------------------------------------
// Pipeline Runners
// ---------------------------------------------------------------------------

/**
 * Run the compile pipeline stages in sequence.
 * Handles the git commit of plan artifacts before the plan-review-cycle stage.
 */
export async function* runCompilePipeline(
  ctx: PipelineContext,
): AsyncGenerator<EforgeEvent> {
  // Index-based iteration: ctx.profile may change mid-pipeline (e.g., planner
  // stage switches from excursion to expedition), so re-read ctx.profile.compile
  // on each iteration instead of capturing it once via for...of.
  let i = 0;
  while (i < ctx.profile.compile.length) {
    const stageName = ctx.profile.compile[i];
    if (stageName === 'plan-review-cycle') {
      // Commit plan artifacts before running plan review
      // (plan review reads committed files)
      if (ctx.plans.length > 0) {
        await commitPlanArtifacts(ctx.cwd, ctx.planSetName);
      }
    }
    const stage = getCompileStage(stageName);
    yield* stage(ctx);
    i++;
  }
}

/**
 * Run the build pipeline stages in sequence for a single plan.
 */
export async function* runBuildPipeline(
  ctx: BuildStageContext,
): AsyncGenerator<EforgeEvent> {
  yield { type: 'build:start', planId: ctx.planId };

  for (const stageName of ctx.profile.build) {
    const stage = getBuildStage(stageName);
    yield* stage(ctx);

    // Stop pipeline if a stage signaled failure (e.g., implement stage)
    if (ctx.buildFailed) return;
  }

  yield { type: 'build:complete', planId: ctx.planId };
}

/**
 * Commit plan artifacts to git (required for worktree-based builds).
 */
async function commitPlanArtifacts(cwd: string, planSetName: string): Promise<void> {
  const planDir = resolve(cwd, 'plans', planSetName);
  await exec('git', ['add', planDir], { cwd });
  await exec('git', ['commit', '-m', `plan(${planSetName}): initial planning artifacts`], { cwd });
}

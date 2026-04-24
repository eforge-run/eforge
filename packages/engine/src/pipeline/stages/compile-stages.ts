/**
 * Built-in compile stages — all six compile stage registrations.
 *
 * Long stage bodies delegate to module-level helper functions so each stage
 * generator stays within 80 lines.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { EforgeEvent, ExpeditionModule } from '../../events.js';
import {
  withRetry,
  DEFAULT_RETRY_POLICIES,
  type RetryPolicy,
  type PlannerContinuationInput,
} from '../../retry.js';
import { runPlanner } from '../../agents/planner.js';
import { runModulePlanner } from '../../agents/module-planner.js';
import { runPlanReview } from '../../agents/plan-reviewer.js';
import { runPlanEvaluate, runCohesionEvaluate, runArchitectureEvaluate } from '../../agents/plan-evaluator.js';
import { runCohesionReview } from '../../agents/cohesion-reviewer.js';
import { runArchitectureReview } from '../../agents/architecture-reviewer.js';
import { parseBuildConfigBlock } from '../../agents/common.js';
import { composePipeline } from '../../agents/pipeline-composer.js';
import { compileExpedition } from '../../compiler.js';
import { resolveDependencyGraph, injectPipelineIntoOrchestrationYaml, parseOrchestrationConfig } from '../../plan.js';
import { runParallel, type ParallelTask } from '../../concurrency.js';
import type { ResolvedAgentConfig } from '../../config.js';

import type { PipelineContext } from '../types.js';
import { registerCompileStage } from '../registry.js';
import { resolveAgentConfig } from '../agent-config.js';
import { createToolTracker, createStageSpanWiring } from '../span-wiring.js';
import { backfillDependsOn } from '../misc.js';
import { runReviewCycle } from '../runners.js';

// ---------------------------------------------------------------------------
// Module-level helpers (extracted from long stage bodies)
// ---------------------------------------------------------------------------

/**
 * Run a single planner attempt (per-retry span + event processing).
 * Extracted from plannerStage to keep the stage body within 80 lines.
 */
async function* runPlannerAttempt(
  input: PlannerContinuationInput,
  ctx: PipelineContext,
  agentConfig: ResolvedAgentConfig,
): AsyncGenerator<EforgeEvent> {
  const { tracker, end, error } = createStageSpanWiring('planner', ctx.tracing, { source: ctx.sourceContent, planSet: ctx.planSetName });
  try {
    for await (const event of runPlanner(ctx.sourceContent, {
      cwd: ctx.cwd,
      name: ctx.planSetName,
      auto: ctx.auto,
      verbose: ctx.verbose,
      abortController: ctx.abortController,
      backend: ctx.backend,
      onClarification: ctx.onClarification,
      scope: ctx.pipeline.scope,
      outputDir: ctx.config.plan.outputDir,
      ...agentConfig,
      ...(input.plannerOptions.continuationContext && { continuationContext: input.plannerOptions.continuationContext }),
    })) {
      // Capture expedition modules from the planner's architecture submission.
      // The planner emits this event directly after writing architecture.md +
      // index.yaml; downstream compile stages gate on ctx.expeditionModules.
      if (event.type === 'expedition:architecture:complete' && ctx.expeditionModules.length === 0) {
        ctx.expeditionModules = event.modules;
      }

      tracker.handleEvent(event);

      // Track skip — halts further compile stages.
      if (event.type === 'planning:skip') {
        ctx.skipped = true;
      }

      // Suppress planner's planning:complete in expedition mode (compilation emits the real one).
      if (event.type === 'planning:complete' && ctx.expeditionModules.length > 0) {
        continue;
      }

      // Track final plans for review phase and inject pipeline into orchestration.yaml.
      if (event.type === 'planning:complete') {
        const orchYamlPath = resolve(ctx.cwd, ctx.config.plan.outputDir, ctx.planSetName, 'orchestration.yaml');

        // Both injectPipelineIntoOrchestrationYaml() and parseOrchestrationConfig() read
        // orchestration.yaml from disk. If the planner failed to write it, the file won't
        // exist and either call would throw ENOENT. Wrap both in the same try/catch so we
        // fall through to yield the original unenriched plans on any failure.
        try {
          // Inject the pipeline composition (and correct baseBranch) into the planner-written orchestration.yaml.
          await injectPipelineIntoOrchestrationYaml(orchYamlPath, ctx.pipeline, ctx.baseBranch);

          const orchConfig = await parseOrchestrationConfig(orchYamlPath);
          // Yield planning:warning events for any orchestration config warnings
          for (const warning of orchConfig.warnings ?? []) {
            yield { timestamp: new Date().toISOString(), type: 'planning:warning', message: warning, source: 'parseOrchestrationConfig' };
          }
          const enrichedPlans = backfillDependsOn(event.plans, orchConfig);
          ctx.plans = enrichedPlans;
          yield { ...event, plans: enrichedPlans };
          continue;
        } catch {
          // Graceful fallback — yield the original event unchanged.
          ctx.plans = event.plans;
        }
      }

      yield event;
    }
    end();
  } catch (err) {
    error(err as Error);
    throw err;
  }
}

/**
 * Run a single module planner attempt for one expedition module.
 * Extracted from modulePlanningStage to keep the stage body within 80 lines.
 * Uses direct span/tracker creation (createStageSpanWiring uses same metadata for
 * createSpan and setInput, but the original code uses different metadata for each).
 */
async function* runModulePlannerAttempt(
  mod: ExpeditionModule,
  ctx: PipelineContext,
  architectureContent: string,
  completedPlans: Map<string, string>,
  agentConfig: ResolvedAgentConfig,
): AsyncGenerator<EforgeEvent> {
  // Gather completed dependency plan content from earlier waves
  const depContent = mod.dependsOn
    .map((depId) => completedPlans.get(depId))
    .filter((c): c is string => c !== undefined);
  const dependencyPlanContent = depContent.length > 0
    ? depContent.join('\n\n---\n\n')
    : undefined;

  // Span metadata differs between createSpan and setInput — use direct creation.
  const modSpan = ctx.tracing.createSpan('module-planner', { moduleId: mod.id });
  modSpan.setInput({ moduleId: mod.id, description: mod.description });
  const modTracker = createToolTracker(modSpan);

  try {
    for await (const event of runModulePlanner({
      backend: ctx.backend,
      cwd: ctx.cwd,
      planSetName: ctx.planSetName,
      moduleId: mod.id,
      moduleDescription: mod.description,
      moduleDependsOn: mod.dependsOn,
      architectureContent,
      sourceContent: ctx.sourceContent,
      dependencyPlanContent,
      verbose: ctx.verbose,
      onClarification: ctx.onClarification,
      abortController: ctx.abortController,
      outputDir: ctx.config.plan.outputDir,
      ...agentConfig,
    })) {
      modTracker.handleEvent(event);

      // Intercept <build-config> blocks from module planner messages
      if (event.type === 'agent:message') {
        const buildConfig = parseBuildConfigBlock(event.content);
        if (buildConfig) {
          ctx.moduleBuildConfigs.set(mod.id, buildConfig);
        }
      }

      yield event;
    }
    modTracker.cleanup();
    modSpan.end();
  } catch (err) {
    // Module planning failure is non-fatal - continue with other modules
    modTracker.cleanup();
    modSpan.error(err as Error);
  }
}

// ---------------------------------------------------------------------------
// Built-in Compile Stages
// ---------------------------------------------------------------------------

registerCompileStage({
  name: 'planner',
  phase: 'compile',
  description: 'Runs the LLM planner agent to decompose a PRD into implementation plans with dependency graphs.',
  whenToUse: 'For any task that needs LLM-driven planning and decomposition. The default compile entry point.',
  costHint: 'high',
  conflictsWith: [],
  parallelizable: false,
}, async function* plannerStage(ctx) {
  // Run pipeline composition first (fast LLM call to determine scope and stages)
  const composerConfig = resolveAgentConfig('pipeline-composer', ctx.config, ctx.config.backend);
  for await (const event of composePipeline({
    backend: ctx.backend,
    source: ctx.sourceContent,
    cwd: ctx.cwd,
    verbose: ctx.verbose,
    abortController: ctx.abortController,
    ...composerConfig,
  })) {
    if (event.type === 'planning:pipeline') {
      // Update the context pipeline from the composer result
      ctx.pipeline = {
        scope: event.scope as 'errand' | 'excursion' | 'expedition',
        compile: event.compile,
        defaultBuild: event.defaultBuild,
        defaultReview: event.defaultReview,
        rationale: event.rationale,
      };
    }
    yield event;
  }

  // Guard: if the composer replaced the compile pipeline without 'planner', delegate.
  if (!ctx.pipeline.compile.includes('planner')) {
    yield { timestamp: new Date().toISOString(), type: 'planning:progress', message: `Pipeline composer selected [${ctx.pipeline.compile.join(', ')}] — delegating to new compile stages.` };
    return;
  }

  const agentConfig = resolveAgentConfig('planner', ctx.config, ctx.config.backend);
  const initialInput: PlannerContinuationInput = {
    sideEffects: {
      cwd: ctx.cwd,
      planCommitCwd: ctx.planCommitCwd,
      planSetName: ctx.planSetName,
      outputDir: ctx.config.plan.outputDir,
    },
    plannerOptions: {},
  };
  const plannerPolicy = DEFAULT_RETRY_POLICIES.planner as RetryPolicy<PlannerContinuationInput>;
  yield* withRetry((input) => runPlannerAttempt(input, ctx, agentConfig), plannerPolicy, initialInput);

  // Fail loudly if the planner produced expedition modules but compile-expedition
  // is not queued — that stage is the only source of orchestration.yaml, so a
  // silent "Compile complete" would leak into the build phase as a confusing
  // "orchestration.yaml not found" error.
  if (ctx.expeditionModules.length > 0 && !ctx.pipeline.compile.includes('compile-expedition')) {
    throw new Error(
      `Planner identified ${ctx.expeditionModules.length} expedition modules but the compile pipeline `
      + `does not include 'compile-expedition'. orchestration.yaml will not be generated. `
      + `Current compile stages: [${ctx.pipeline.compile.join(', ')}]`,
    );
  }
});

registerCompileStage({
  name: 'plan-review-cycle',
  phase: 'compile',
  description: 'Runs a review-evaluate cycle on generated plans to catch scope and quality issues before build.',
  whenToUse: 'For medium-to-large tasks where plan quality matters. Adds a quality gate between planning and building.',
  costHint: 'medium',
  predecessors: ['planner'],
  parallelizable: false,
}, async function* planReviewCycleStage(ctx) {
  const verbose = ctx.verbose;
  const abortController = ctx.abortController;
  const reviewerConfig = resolveAgentConfig('plan-reviewer', ctx.config, ctx.config.backend);
  const evaluatorConfig = resolveAgentConfig('plan-evaluator', ctx.config, ctx.config.backend);

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
          outputDir: ctx.config.plan.outputDir,
          ...reviewerConfig,
        }),
      },
      evaluator: {
        role: 'plan-evaluator',
        metadata: { planSet: ctx.planSetName },
        run: (continuationContext) => runPlanEvaluate({
          backend: ctx.backend,
          planSetName: ctx.planSetName,
          sourceContent: ctx.sourceContent,
          cwd: ctx.cwd,
          verbose,
          abortController,
          outputDir: ctx.config.plan.outputDir,
          ...evaluatorConfig,
          continuationContext,
        }),
      },
    });
  } catch (err) {
    // Plan review failure is non-fatal - plan artifacts are already committed
    yield { timestamp: new Date().toISOString(), type: 'planning:progress', message: `Plan review skipped: ${(err as Error).message}` };
  }
});

registerCompileStage({
  name: 'architecture-review-cycle',
  phase: 'compile',
  description: 'Reviews the architecture document produced by the planner in expedition mode for completeness and correctness.',
  whenToUse: 'For expedition-scale work where an architecture document defines module boundaries and contracts.',
  costHint: 'medium',
  predecessors: ['planner'],
  parallelizable: false,
}, async function* architectureReviewCycleStage(ctx) {
  // Only meaningful in expedition mode
  if (ctx.expeditionModules.length === 0) return;

  const cwd = ctx.cwd;
  const planDir = resolve(cwd, ctx.config.plan.outputDir, ctx.planSetName);
  const verbose = ctx.verbose;
  const abortController = ctx.abortController;
  const backend = ctx.backend;
  const sourceContent = ctx.sourceContent;
  const planSetName = ctx.planSetName;

  // Read architecture content for review — if the planner didn't produce
  // architecture.md, something went wrong; skip rather than reviewing nothing.
  let architectureContent: string;
  try {
    architectureContent = await readFile(resolve(planDir, 'architecture.md'), 'utf-8');
  } catch {
    return;
  }

  const archReviewerConfig = resolveAgentConfig('architecture-reviewer', ctx.config, ctx.config.backend);
  const archEvaluatorConfig = resolveAgentConfig('architecture-evaluator', ctx.config, ctx.config.backend);

  try {
    yield* runReviewCycle({
      tracing: ctx.tracing,
      cwd,
      reviewer: {
        role: 'architecture-reviewer',
        metadata: { planSet: planSetName },
        run: () => runArchitectureReview({ backend, sourceContent, planSetName, architectureContent, cwd, verbose, abortController, outputDir: ctx.config.plan.outputDir, ...archReviewerConfig }),
      },
      evaluator: {
        role: 'architecture-evaluator',
        metadata: { planSet: planSetName },
        run: (continuationContext) => runArchitectureEvaluate({ backend, planSetName, sourceContent, cwd, verbose, abortController, outputDir: ctx.config.plan.outputDir, ...archEvaluatorConfig, continuationContext }),
      },
    });
  } catch (err) {
    yield { timestamp: new Date().toISOString(), type: 'planning:progress', message: `Architecture review skipped: ${(err as Error).message}` };
  }
});

registerCompileStage({
  name: 'module-planning',
  phase: 'compile',
  description: 'Plans individual modules in dependency order, running module planners in parallel within each wave.',
  whenToUse: 'For expedition-scale work after architecture review, when the planner has identified modules.',
  costHint: 'high',
  predecessors: ['planner'],
  parallelizable: false,
}, async function* modulePlanningStage(ctx) {
  // Only runs when expedition modules are detected
  if (ctx.expeditionModules.length === 0) return;

  const cwd = ctx.cwd;
  const planDir = resolve(cwd, ctx.config.plan.outputDir, ctx.planSetName);

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
  const agentConfig = resolveAgentConfig('module-planner', ctx.config, ctx.config.backend);

  // 2. Plan each wave (parallel within wave, sequential across waves)
  for (let waveIdx = 0; waveIdx < waves.length; waveIdx++) {
    const waveModuleIds = waves[waveIdx];
    yield { timestamp: new Date().toISOString(), type: 'expedition:wave:start', wave: waveIdx + 1, moduleIds: waveModuleIds };

    const waveTasks: ParallelTask<EforgeEvent>[] = waveModuleIds.map((modId) => ({
      id: modId,
      run: () => runModulePlannerAttempt(moduleMap.get(modId)!, ctx, architectureContent, completedPlans, agentConfig),
    }));

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

    yield { timestamp: new Date().toISOString(), type: 'expedition:wave:complete', wave: waveIdx + 1 };
  }
});

registerCompileStage({
  name: 'cohesion-review-cycle',
  phase: 'compile',
  description: 'Reviews module plans for cohesion and consistency with the architecture document.',
  whenToUse: 'For expedition-scale work after module planning, to ensure modules work together coherently.',
  costHint: 'medium',
  predecessors: ['planner', 'module-planning'],
  parallelizable: false,
}, async function* cohesionReviewCycleStage(ctx) {
  // Only meaningful in expedition mode
  if (ctx.expeditionModules.length === 0) return;

  const cwd = ctx.cwd;
  const planDir = resolve(cwd, ctx.config.plan.outputDir, ctx.planSetName);
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

  const cohesionReviewerConfig = resolveAgentConfig('cohesion-reviewer', ctx.config, ctx.config.backend);
  const cohesionEvaluatorConfig = resolveAgentConfig('cohesion-evaluator', ctx.config, ctx.config.backend);

  try {
    yield* runReviewCycle({
      tracing: ctx.tracing,
      cwd,
      reviewer: {
        role: 'cohesion-reviewer',
        metadata: { planSet: planSetName },
        run: () => runCohesionReview({ backend, sourceContent, planSetName, architectureContent, cwd, verbose, abortController, outputDir: ctx.config.plan.outputDir, ...cohesionReviewerConfig }),
      },
      evaluator: {
        role: 'cohesion-evaluator',
        metadata: { planSet: planSetName },
        run: (continuationContext) => runCohesionEvaluate({ backend, planSetName, sourceContent, cwd, verbose, abortController, outputDir: ctx.config.plan.outputDir, ...cohesionEvaluatorConfig, continuationContext }),
      },
    });
  } catch (err) {
    yield { timestamp: new Date().toISOString(), type: 'planning:progress', message: `Cohesion review skipped: ${(err as Error).message}` };
  }
});

registerCompileStage({
  name: 'compile-expedition',
  phase: 'compile',
  description: 'Compiles module plans into concrete plan files with orchestration config for the build phase.',
  whenToUse: 'Final compile stage for expedition-scale work. Produces the plan files that build stages consume.',
  costHint: 'low',
  predecessors: ['planner', 'module-planning'],
  parallelizable: false,
}, async function* compileExpeditionStage(ctx) {
  // Only runs when expedition modules are detected
  if (ctx.expeditionModules.length === 0) return;

  yield { timestamp: new Date().toISOString(), type: 'expedition:compile:start' };
  const plans = await compileExpedition(ctx.cwd, ctx.planSetName, ctx.moduleBuildConfigs, ctx.config.plan.outputDir);

  // Write the full pipeline composition and backfill per-plan build/review from
  // defaults for any module whose planner didn't emit a <build-config> block.
  // Without this, parseOrchestrationConfig rejects the file.
  const orchYamlPath = resolve(ctx.cwd, ctx.config.plan.outputDir, ctx.planSetName, 'orchestration.yaml');
  await injectPipelineIntoOrchestrationYaml(orchYamlPath, ctx.pipeline, ctx.baseBranch);

  yield { timestamp: new Date().toISOString(), type: 'expedition:compile:complete', plans };
  yield { timestamp: new Date().toISOString(), type: 'planning:complete', plans };

  // Update context plans for downstream stages
  ctx.plans = plans;
});

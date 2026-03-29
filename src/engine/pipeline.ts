/**
 * Pipeline — named stages with a uniform interface, driven by resolved profiles.
 *
 * Pipeline stages are named units: each accepts a context and yields EforgeEvents.
 * The engine iterates the stage list from the resolved profile and calls each stage
 * in sequence. Profile selection is a pre-pipeline step handled by the engine.
 */

import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { parse as parseYaml } from 'yaml';

import {
  SEVERITY_ORDER,
  type EforgeEvent,
  type AgentRole,
  type AgentResultData,
  type PlanFile,
  type ClarificationQuestion,
  type ExpeditionModule,
  type ReviewIssue,
  type OrchestrationConfig,
} from './events.js';
import type { EforgeConfig, ResolvedProfileConfig, BuildStageSpec, ReviewProfileConfig } from './config.js';
import { DEFAULT_REVIEW, DEFAULT_BUILD } from './config.js';
import type { AgentBackend } from './backend.js';
import type { TracingContext, SpanHandle, ToolCallHandle } from './tracing.js';
import { runPlanner } from './agents/planner.js';
import { runModulePlanner } from './agents/module-planner.js';
import { builderImplement, builderEvaluate } from './agents/builder.js';
import { runDocUpdater } from './agents/doc-updater.js';
import { runParallelReview } from './agents/parallel-reviewer.js';
import { runReviewFixer } from './agents/review-fixer.js';
import { runPlanReview } from './agents/plan-reviewer.js';
import { runPlanEvaluate, runCohesionEvaluate, runArchitectureEvaluate } from './agents/plan-evaluator.js';
import { runCohesionReview } from './agents/cohesion-reviewer.js';
import { runArchitectureReview } from './agents/architecture-reviewer.js';
import { parseModulesBlock, parseBuildConfigBlock, testIssueToReviewIssue } from './agents/common.js';
import { runTestWriter, runTester } from './agents/tester.js';
import { compileExpedition } from './compiler.js';
import { resolveDependencyGraph, injectProfileIntoOrchestrationYaml, parseOrchestrationConfig, writePlanArtifacts, extractPlanTitle, detectValidationCommands, parsePlanFile } from './plan.js';
import { runParallel, type ParallelTask } from './concurrency.js';
import { forgeCommit } from './git.js';

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
  generateProfile?: boolean;
  abortController?: AbortController;
  onClarification?: (questions: ClarificationQuestion[]) => Promise<Record<string, string>>;

  /** Working directory for plan artifact commits (merge worktree during compile, defaults to cwd). */
  planCommitCwd?: string;

  /** The actual base branch from repoRoot (before worktree creation). When cwd is a merge worktree,
   *  `git rev-parse --abbrev-ref HEAD` returns the feature branch, not the real base. */
  baseBranch?: string;

  // Mutable state passed between stages
  plans: PlanFile[];
  expeditionModules: ExpeditionModule[];
  moduleBuildConfigs: Map<string, { build: BuildStageSpec[]; review: ReviewProfileConfig }>;
  /** Set by planner stage when plan:skip is emitted — halts further compile stages. */
  skipped?: boolean;
}

/** Context for build stages, extends PipelineContext with per-plan fields. */
export interface BuildStageContext extends PipelineContext {
  planId: string;
  worktreePath: string;
  planFile: PlanFile;
  orchConfig: OrchestrationConfig;
  reviewIssues: ReviewIssue[];
  /** Per-plan build stage sequence (resolved from per-plan config or profile fallback). */
  build: BuildStageSpec[];
  /** Per-plan review config (resolved from per-plan config or profile fallback). */
  review: ReviewProfileConfig;
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

/** Return the set of registered compile stage names (for profile validation). */
export function getCompileStageNames(): Set<string> {
  return new Set(compileStages.keys());
}

/** Return the set of registered build stage names (for profile validation). */
export function getBuildStageNames(): Set<string> {
  return new Set(buildStages.keys());
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
    cacheRead: data.usage.cacheRead,
    cacheCreation: data.usage.cacheCreation,
  };
  for (const [model, mu] of Object.entries(data.modelUsage)) {
    usageDetails[`${model}:input`] = mu.inputTokens;
    usageDetails[`${model}:output`] = mu.outputTokens;
    usageDetails[`${model}:cacheRead`] = mu.cacheReadInputTokens;
    usageDetails[`${model}:cacheCreation`] = mu.cacheCreationInputTokens;
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

/** Per-role built-in defaults. Agents that need different settings than the global default declare them here. */
export const AGENT_ROLE_DEFAULTS: Partial<Record<AgentRole, Partial<import('./config.js').ResolvedAgentConfig>>> = {
  builder: { maxTurns: 50 },
  'module-planner': { maxTurns: 20 },
  'doc-updater': { maxTurns: 20 },
  'test-writer': { maxTurns: 30 },
  'tester': { maxTurns: 40 },
};

/** Per-role default maxContinuations for agents that support continuation loops. */
export const AGENT_MAX_CONTINUATIONS_DEFAULTS: Partial<Record<AgentRole, number>> = {
  planner: 2,
};

/**
 * Resolve agent config for a given role.
 * Four-tier priority (highest → lowest):
 *   1. User per-role config (config.agents.roles[role])
 *   2. User global config (config.agents.{model,thinking,effort,...}, config.agents.maxTurns)
 *   3. Built-in per-role defaults (AGENT_ROLE_DEFAULTS[role])
 *   4. Built-in global default (DEFAULT_CONFIG.agents.maxTurns)
 *
 * Each field is resolved independently through the chain.
 */
export function resolveAgentConfig(
  role: AgentRole,
  config: EforgeConfig,
): import('./config.js').ResolvedAgentConfig {
  const builtinRoleDefaults = AGENT_ROLE_DEFAULTS[role] ?? {};
  const userGlobal: import('./config.js').ResolvedAgentConfig = {
    maxTurns: config.agents.maxTurns,
    model: config.agents.model,
    thinking: config.agents.thinking,
    effort: config.agents.effort,
  };
  const userRole = config.agents.roles?.[role] ?? {};

  // For each field: user per-role > built-in per-role > user global > built-in global
  // Special case for maxTurns: built-in per-role beats user global (e.g. builder's 50 beats global 30)
  // but user per-role always wins.
  const SDK_FIELDS = ['model', 'thinking', 'effort', 'maxBudgetUsd', 'fallbackModel', 'allowedTools', 'disallowedTools'] as const;

  const result: import('./config.js').ResolvedAgentConfig = {};

  // Resolve maxTurns: user per-role > built-in per-role > user global
  result.maxTurns = userRole.maxTurns ?? builtinRoleDefaults.maxTurns ?? userGlobal.maxTurns;

  // Resolve SDK passthrough fields: user per-role > user global > built-in per-role
  for (const field of SDK_FIELDS) {
    const value = userRole[field] ?? userGlobal[field] ?? builtinRoleDefaults[field];
    if (value !== undefined) {
      (result as Record<string, unknown>)[field] = value;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Dependency backfill
// ---------------------------------------------------------------------------

/**
 * Enrich plan files with dependsOn from orchestration config.
 * The planner writes depends_on only to orchestration.yaml, not to individual
 * plan file frontmatter. This function cross-references the two sources.
 */
export function backfillDependsOn(
  plans: PlanFile[],
  orchConfig: OrchestrationConfig,
): PlanFile[] {
  const depsMap = new Map(orchConfig.plans.map((p) => [p.id, p.dependsOn]));
  return plans.map((plan) => {
    const deps = depsMap.get(plan.id);
    if (deps && deps.length > 0 && plan.dependsOn.length === 0) {
      return { ...plan, dependsOn: deps };
    }
    return plan;
  });
}

// ---------------------------------------------------------------------------
// Issue severity filtering
// ---------------------------------------------------------------------------

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
// Helpers — PRD metadata extraction
// ---------------------------------------------------------------------------

/**
 * Extract metadata from PRD content: title from YAML frontmatter or H1 heading,
 * and body with frontmatter stripped.
 */
export function extractPrdMetadata(
  content: string,
  fallbackName: string,
): { title: string; body: string } {
  // Try YAML frontmatter title
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (fmMatch) {
    const frontmatter = parseYaml(fmMatch[1]) as Record<string, unknown>;
    const body = fmMatch[2].trim();
    if (typeof frontmatter.title === 'string' && frontmatter.title.trim()) {
      return { title: frontmatter.title.trim(), body };
    }
    // No title in frontmatter — try H1 in body
    const h1Title = extractPlanTitle(body);
    if (h1Title) return { title: h1Title, body };
    // Fall back to humanized planSetName
    return { title: humanizeName(fallbackName), body };
  }

  // No frontmatter — try H1 heading
  const h1Title = extractPlanTitle(content);
  if (h1Title) return { title: h1Title, body: content };

  // Fall back to humanized planSetName
  return { title: humanizeName(fallbackName), body: content };
}

/** Convert kebab-case name to a human-readable title. */
function humanizeName(name: string): string {
  return name
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

// ---------------------------------------------------------------------------
// Built-in Compile Stages
// ---------------------------------------------------------------------------

registerCompileStage('prd-passthrough', async function* prdPassthroughStage(ctx) {
  yield { timestamp: new Date().toISOString(), type: 'plan:start', source: ctx.sourceContent, label: 'prd-passthrough' };

  // Extract title and body from PRD
  const { title, body } = extractPrdMetadata(ctx.sourceContent, ctx.planSetName);

  // Profile event
  yield { timestamp: new Date().toISOString(), type: 'plan:profile', profileName: 'errand', rationale: 'PRD passthrough uses errand profile' };

  yield { timestamp: new Date().toISOString(), type: 'plan:progress', message: 'Writing plan artifacts from PRD content' };

  // Get base branch — prefer ctx.baseBranch (resolved from repoRoot before worktree creation)
  // to avoid picking up the feature branch when cwd is a merge worktree
  const baseBranch = ctx.baseBranch
    ?? (await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ctx.cwd })).stdout.trim();

  // Detect validation commands from project
  const validate = await detectValidationCommands(ctx.cwd);

  // Write plan artifacts using the shared helper
  const planFile = await writePlanArtifacts({
    cwd: ctx.cwd,
    planSetName: ctx.planSetName,
    sourceContent: body,
    planName: title,
    baseBranch,
    profile: ctx.profile,
    validate: validate.length > 0 ? validate : undefined,
    mode: 'errand',
    build: DEFAULT_BUILD,
    review: DEFAULT_REVIEW,
    outputDir: ctx.config.plan.outputDir,
  });

  ctx.plans = [planFile];

  // Commit plan artifacts (prd-passthrough replaces both planner + review,
  // so it must commit its own artifacts for the build phase to create worktrees)
  const commitCwd = ctx.planCommitCwd ?? ctx.cwd;
  const planDir = resolve(ctx.cwd, ctx.config.plan.outputDir, ctx.planSetName);
  await exec('git', ['add', planDir], { cwd: commitCwd });
  await forgeCommit(commitCwd, `plan(${ctx.planSetName}): PRD passthrough artifacts`);

  yield { timestamp: new Date().toISOString(), type: 'plan:complete', plans: [planFile] };
});

registerCompileStage('planner', async function* plannerStage(ctx) {
  const agentConfig = resolveAgentConfig('planner', ctx.config);
  const maxContinuations = AGENT_MAX_CONTINUATIONS_DEFAULTS['planner'] ?? 0;

  for (let attempt = 0; attempt <= maxContinuations; attempt++) {
    const span = ctx.tracing.createSpan('planner', { source: ctx.sourceContent, planSet: ctx.planSetName, ...(attempt > 0 && { attempt }) });
    span.setInput({ source: ctx.sourceContent, planSet: ctx.planSetName, ...(attempt > 0 && { attempt }) });
    const tracker = createToolTracker(span);

    // Build continuation context for retry attempts
    let continuationContext: { attempt: number; maxContinuations: number; existingPlans: string } | undefined;
    if (attempt > 0) {
      const planDir = resolve(ctx.cwd, ctx.config.plan.outputDir, ctx.planSetName);
      let existingPlans = '[No existing plans found]';
      if (existsSync(planDir)) {
        try {
          const entries = await readdir(planDir);
          const mdFiles = entries.filter((f) => f.endsWith('.md')).sort();
          const summaries: string[] = [];
          for (const file of mdFiles) {
            try {
              const plan = await parsePlanFile(resolve(planDir, file));
              summaries.push(`- **${plan.id}**: ${plan.name}`);
            } catch {
              summaries.push(`- ${file} (could not parse frontmatter)`);
            }
          }
          if (summaries.length > 0) {
            existingPlans = summaries.join('\n');
          }
        } catch {
          // If we can't read the directory, continue with default text
        }
      }
      continuationContext = { attempt, maxContinuations, existingPlans };
    }

    let plannerFailed = false;
    let failedError = '';

    try {
      for await (const event of runPlanner(ctx.sourceContent, {
        cwd: ctx.cwd,
        name: ctx.planSetName,
        auto: ctx.auto,
        verbose: ctx.verbose,
        generateProfile: ctx.generateProfile,
        abortController: ctx.abortController,
        backend: ctx.backend,
        onClarification: ctx.onClarification,
        profiles: ctx.config.profiles,
        outputDir: ctx.config.plan.outputDir,
        ...agentConfig,
        continuationContext,
      })) {
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
            yield { timestamp: new Date().toISOString(), type: 'expedition:architecture:complete', modules };
          }
        }

        tracker.handleEvent(event);

        // Track skip — halts further compile stages
        if (event.type === 'plan:skip') {
          ctx.skipped = true;
        }

        // Suppress planner's plan:complete in expedition mode (compilation emits the real one)
        if (event.type === 'plan:complete' && ctx.expeditionModules.length > 0) {
          continue;
        }

        // Track final plans for review phase and inject profile into orchestration.yaml
        if (event.type === 'plan:complete') {
          // Inject the resolved profile (and correct baseBranch) into the planner-written orchestration.yaml.
          // The planner sees the merge worktree's feature branch as HEAD, so base_branch needs overriding.
          const orchYamlPath = resolve(ctx.cwd, ctx.config.plan.outputDir, ctx.planSetName, 'orchestration.yaml');
          await injectProfileIntoOrchestrationYaml(orchYamlPath, ctx.profile, ctx.baseBranch);

          // Backfill dependsOn from orchestration.yaml into plan:complete events.
          // The planner writes depends_on to orchestration.yaml but not to individual
          // plan file frontmatter, so parsePlanFile() returns empty dependsOn arrays.
          // Cross-reference orchestration.yaml to enrich the event.
          try {
            const orchConfig = await parseOrchestrationConfig(orchYamlPath);
            const enrichedPlans = backfillDependsOn(event.plans, orchConfig);
            ctx.plans = enrichedPlans;
            yield { ...event, plans: enrichedPlans };
            continue;
          } catch {
            // Graceful fallback — yield the original event unchanged
            ctx.plans = event.plans;
          }
        }

        yield event;
      }
      tracker.cleanup();
      span.end();
      break; // Success — exit the continuation loop
    } catch (err) {
      tracker.cleanup();
      const errorMsg = (err as Error).message ?? String(err);

      // Check if this is an error_max_turns failure eligible for continuation
      const isMaxTurns = errorMsg.includes('error_max_turns');
      if (isMaxTurns && attempt < maxContinuations) {
        // Commit any plan files written so far as a checkpoint
        await commitPlanArtifacts(ctx.planCommitCwd ?? ctx.cwd, ctx.planSetName, ctx.cwd, ctx.config.plan.outputDir);

        span.end();

        // Yield continuation event and retry
        yield { timestamp: new Date().toISOString(), type: 'plan:continuation', attempt: attempt + 1, maxContinuations } as EforgeEvent;
        continue; // Next iteration of the continuation loop
      }

      // Non-max_turns error or exhausted continuations — rethrow
      span.error(err as Error);
      throw err;
    }
  }
});

registerCompileStage('plan-review-cycle', async function* planReviewCycleStage(ctx) {
  const verbose = ctx.verbose;
  const abortController = ctx.abortController;
  const reviewerConfig = resolveAgentConfig('plan-reviewer', ctx.config);
  const evaluatorConfig = resolveAgentConfig('plan-evaluator', ctx.config);

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
        run: () => runPlanEvaluate({
          backend: ctx.backend,
          planSetName: ctx.planSetName,
          sourceContent: ctx.sourceContent,
          cwd: ctx.cwd,
          verbose,
          abortController,
          outputDir: ctx.config.plan.outputDir,
          ...evaluatorConfig,
        }),
      },
    });
  } catch (err) {
    // Plan review failure is non-fatal - plan artifacts are already committed
    yield { timestamp: new Date().toISOString(), type: 'plan:progress', message: `Plan review skipped: ${(err as Error).message}` };
  }
});

registerCompileStage('architecture-review-cycle', async function* architectureReviewCycleStage(ctx) {
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

  const archReviewerConfig = resolveAgentConfig('architecture-reviewer', ctx.config);
  const archEvaluatorConfig = resolveAgentConfig('architecture-evaluator', ctx.config);

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
        run: () => runArchitectureEvaluate({ backend, planSetName, sourceContent, cwd, verbose, abortController, outputDir: ctx.config.plan.outputDir, ...archEvaluatorConfig }),
      },
    });
  } catch (err) {
    yield { timestamp: new Date().toISOString(), type: 'plan:progress', message: `Architecture review skipped: ${(err as Error).message}` };
  }
});

registerCompileStage('module-planning', async function* modulePlanningStage(ctx) {
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

  const backend = ctx.backend;
  const onClarification = ctx.onClarification;
  const verbose = ctx.verbose;
  const abortController = ctx.abortController;
  const tracing = ctx.tracing;
  const sourceContent = ctx.sourceContent;
  const planSetName = ctx.planSetName;
  const agentConfig = resolveAgentConfig('module-planner', ctx.config);

  // 2. Plan each wave (parallel within wave, sequential across waves)
  for (let waveIdx = 0; waveIdx < waves.length; waveIdx++) {
    const waveModuleIds = waves[waveIdx];
    yield { timestamp: new Date().toISOString(), type: 'expedition:wave:start', wave: waveIdx + 1, moduleIds: waveModuleIds };

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

    yield { timestamp: new Date().toISOString(), type: 'expedition:wave:complete', wave: waveIdx + 1 };
  }
});

registerCompileStage('cohesion-review-cycle', async function* cohesionReviewCycleStage(ctx) {
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

  const cohesionReviewerConfig = resolveAgentConfig('cohesion-reviewer', ctx.config);
  const cohesionEvaluatorConfig = resolveAgentConfig('cohesion-evaluator', ctx.config);

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
        run: () => runCohesionEvaluate({ backend, planSetName, sourceContent, cwd, verbose, abortController, outputDir: ctx.config.plan.outputDir, ...cohesionEvaluatorConfig }),
      },
    });
  } catch (err) {
    yield { timestamp: new Date().toISOString(), type: 'plan:progress', message: `Cohesion review skipped: ${(err as Error).message}` };
  }
});

registerCompileStage('compile-expedition', async function* compileExpeditionStage(ctx) {
  // Only runs when expedition modules are detected
  if (ctx.expeditionModules.length === 0) return;

  yield { timestamp: new Date().toISOString(), type: 'expedition:compile:start' };
  const plans = await compileExpedition(ctx.cwd, ctx.planSetName, ctx.profile, ctx.moduleBuildConfigs, ctx.config.plan.outputDir);
  yield { timestamp: new Date().toISOString(), type: 'expedition:compile:complete', plans };
  yield { timestamp: new Date().toISOString(), type: 'plan:complete', plans };

  // Update context plans for downstream stages
  ctx.plans = plans;
});

// ---------------------------------------------------------------------------
// Built-in Build Stages
// ---------------------------------------------------------------------------

/** Check whether any build stage in the spec list starts with 'test'. */
function hasTestStages(build: BuildStageSpec[]): boolean {
  return build.some((spec) => {
    if (Array.isArray(spec)) return spec.some((s) => s.startsWith('test'));
    return spec.startsWith('test');
  });
}

/**
 * Build a continuation diff string from a worktree, truncating large diffs
 * to a file-list summary to avoid filling the continuation builder's context.
 */
async function buildContinuationDiff(cwd: string, baseBranch: string): Promise<string> {
  const DIFF_CHAR_LIMIT = 50_000;
  const { stdout: diff } = await exec('git', ['diff', `${baseBranch}...HEAD`], { cwd });
  if (diff.length <= DIFF_CHAR_LIMIT) return diff;

  // Large diff — fall back to file-list summary with per-file stats
  const { stdout: stat } = await exec('git', ['diff', '--stat', `${baseBranch}...HEAD`], { cwd });
  return `[Diff too large (${diff.length} chars) — showing file summary instead]\n\n${stat}`;
}

/**
 * Emit a build:files_changed event listing all files changed vs the base branch.
 * Uses two-dot diff (baseBranch) to capture committed, staged, and unstaged changes.
 * Non-critical — silently skips on failure.
 */
async function* emitFilesChanged(ctx: BuildStageContext): AsyncGenerator<EforgeEvent> {
  try {
    const { stdout } = await exec('git', ['diff', '--name-only', ctx.orchConfig.baseBranch], { cwd: ctx.worktreePath });
    const files = stdout.trim().split('\n').filter(Boolean);
    if (files.length > 0) {
      yield { timestamp: new Date().toISOString(), type: 'build:files_changed', planId: ctx.planId, files };
    }
  } catch {
    // Non-critical - skip silently
  }
}

registerBuildStage('implement', async function* implementStage(ctx) {
  const agentConfig = resolveAgentConfig('builder', ctx.config);

  // Resolve maxContinuations: per-plan > global config > default (3)
  const planEntry = ctx.orchConfig.plans.find((p) => p.id === ctx.planId);
  const maxContinuations = planEntry?.maxContinuations ?? ctx.config.agents.maxContinuations;

  // Extract parallel stage groups from ctx.build for lane awareness
  const parallelStages = ctx.build
    .filter((spec): spec is string[] => Array.isArray(spec));

  const verificationScope = hasTestStages(ctx.build) ? 'build-only' : 'full';

  for (let attempt = 0; attempt <= maxContinuations; attempt++) {
    const implSpan = ctx.tracing.createSpan('builder', { planId: ctx.planId, phase: 'implement', ...(attempt > 0 && { attempt }) });
    implSpan.setInput({ planId: ctx.planId, phase: 'implement', ...(attempt > 0 && { attempt }) });
    const implTracker = createToolTracker(implSpan);
    let implFailed = false;
    let failedError = '';

    // Build continuation context for retry attempts
    let continuationContext: { attempt: number; maxContinuations: number; completedDiff: string } | undefined;
    if (attempt > 0) {
      try {
        const completedDiff = await buildContinuationDiff(ctx.worktreePath, ctx.orchConfig.baseBranch);
        continuationContext = { attempt, maxContinuations, completedDiff };
      } catch {
        // If we can't build the diff, continue without it
        continuationContext = { attempt, maxContinuations, completedDiff: '[Unable to generate diff]' };
      }
    }

    try {
      for await (const event of builderImplement(ctx.planFile, {
        backend: ctx.backend,
        cwd: ctx.worktreePath,
        verbose: ctx.verbose,
        abortController: ctx.abortController,
        ...agentConfig,
        parallelStages,
        verificationScope,
        continuationContext,
      })) {
        implTracker.handleEvent(event);
        if (event.type === 'build:failed') {
          implFailed = true;
          failedError = event.error;
        } else {
          yield event;
        }
      }
    } catch (err) {
      implTracker.cleanup();
      implSpan.error(err as Error);
      yield { timestamp: new Date().toISOString(), type: 'build:failed', planId: ctx.planId, error: (err as Error).message } as EforgeEvent;
      ctx.buildFailed = true;
      return;
    }

    if (implFailed) {
      implTracker.cleanup();

      // Check if this is an error_max_turns failure eligible for continuation
      const isMaxTurns = failedError.includes('error_max_turns');
      if (isMaxTurns && attempt < maxContinuations) {
        // Check if the worktree has changes worth checkpointing
        let hasChanges = false;
        try {
          const { stdout: status } = await exec('git', ['status', '--porcelain'], { cwd: ctx.worktreePath });
          hasChanges = status.trim().length > 0;
        } catch {
          // If we can't check, assume no changes
        }

        if (!hasChanges) {
          // No changes to checkpoint — fail immediately
          implSpan.error('Implementation failed: error_max_turns with no changes');
          yield { timestamp: new Date().toISOString(), type: 'build:failed', planId: ctx.planId, error: failedError } as EforgeEvent;
          ctx.buildFailed = true;
          return;
        }

        // Checkpoint progress: stage all and commit
        try {
          await exec('git', ['add', '-A'], { cwd: ctx.worktreePath });
          await forgeCommit(ctx.worktreePath, `wip(${ctx.planId}): continuation checkpoint (attempt ${attempt + 1})`);
        } catch (checkpointErr) {
          // If commit fails, emit build:failed and stop
          const msg = `Continuation checkpoint failed: ${(checkpointErr as Error).message}`;
          implSpan.error(msg);
          yield { timestamp: new Date().toISOString(), type: 'build:failed', planId: ctx.planId, error: msg } as EforgeEvent;
          ctx.buildFailed = true;
          return;
        }

        implSpan.end();

        // Yield continuation event and retry
        yield { timestamp: new Date().toISOString(), type: 'build:implement:continuation', planId: ctx.planId, attempt: attempt + 1, maxContinuations } as EforgeEvent;
        continue; // Next iteration of the continuation loop
      }

      // Non-max_turns error or exhausted continuations — fail
      implSpan.error('Implementation failed');
      yield { timestamp: new Date().toISOString(), type: 'build:failed', planId: ctx.planId, error: failedError } as EforgeEvent;
      ctx.buildFailed = true;
      return;
    }

    // Success — clean exit from the loop
    implTracker.cleanup();
    implSpan.end();
    break;
  }

  // Emit files changed by implementation (non-critical)
  yield* emitFilesChanged(ctx);
});

registerBuildStage('review', async function* reviewStage(ctx) {
  yield* reviewStageInner(ctx);
});

async function* reviewStageInner(
  ctx: BuildStageContext,
  overrides?: { strategy?: 'auto' | 'single' | 'parallel'; perspectives?: string[] },
): AsyncGenerator<EforgeEvent> {
  const strategy = overrides?.strategy ?? ctx.review.strategy;
  const perspectives = overrides?.perspectives ?? (ctx.review.perspectives.length > 0 ? ctx.review.perspectives : undefined);
  const reviewerAgentConfig = resolveAgentConfig('reviewer', ctx.config);

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
      ...reviewerAgentConfig,
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
    ctx.review.autoAcceptBelow,
  );
  ctx.reviewIssues = filtered;

  // Only runs if review found actionable issues after filtering
  if (ctx.reviewIssues.length === 0) return;

  const fixerAgentConfig = resolveAgentConfig('review-fixer', ctx.config);
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
      ...fixerAgentConfig,
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

  // Emit files changed after review fixes (non-critical)
  yield* emitFilesChanged(ctx);
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

  const strictness = overrides?.strictness ?? ctx.review.evaluatorStrictness;

  const evalSpan = ctx.tracing.createSpan('evaluator', { planId: ctx.planId });
  evalSpan.setInput({ planId: ctx.planId });
  const evalTracker = createToolTracker(evalSpan);

  try {
    const evalAgentConfig = resolveAgentConfig('evaluator', ctx.config);
    for await (const event of builderEvaluate(ctx.planFile, {
      backend: ctx.backend,
      cwd: ctx.worktreePath,
      verbose: ctx.verbose,
      abortController: ctx.abortController,
      ...evalAgentConfig,
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
  const maxRounds = ctx.review.maxRounds;
  const strategy = ctx.review.strategy;
  const perspectives = ctx.review.perspectives.length > 0 ? ctx.review.perspectives : undefined;
  const autoAcceptBelow = ctx.review.autoAcceptBelow;
  const strictness = ctx.review.evaluatorStrictness;

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

registerBuildStage('doc-update', async function* docUpdateStage(ctx) {
  const agentConfig = resolveAgentConfig('doc-updater', ctx.config);
  const docSpan = ctx.tracing.createSpan('doc-updater', { planId: ctx.planId });
  docSpan.setInput({ planId: ctx.planId });
  const docTracker = createToolTracker(docSpan);

  try {
    for await (const event of runDocUpdater({
      backend: ctx.backend,
      cwd: ctx.worktreePath,
      planId: ctx.planId,
      planContent: ctx.planFile.body,
      verbose: ctx.verbose,
      abortController: ctx.abortController,
      ...agentConfig,
    })) {
      docTracker.handleEvent(event);
      yield event;
    }
    docTracker.cleanup();
    docSpan.end();
  } catch (err) {
    docTracker.cleanup();
    docSpan.error(err as Error);
    // Re-throw abort errors so the pipeline can respect cancellation
    if (err instanceof Error && err.name === 'AbortError') throw err;
    // Doc-update failure is non-fatal — don't propagate
  }

  // Emit files changed after doc update (non-critical)
  yield* emitFilesChanged(ctx);
});

// ---------------------------------------------------------------------------
// Test Build Stages
// ---------------------------------------------------------------------------

registerBuildStage('test-write', async function* testWriteStage(ctx) {
  const agentConfig = resolveAgentConfig('test-writer', ctx.config);
  const span = ctx.tracing.createSpan('test-writer', { planId: ctx.planId });
  span.setInput({ planId: ctx.planId });
  const tracker = createToolTracker(span);

  // Get implementation diff for post-implementation context
  let implementationContext = '';
  try {
    const { stdout } = await exec('git', ['diff', `${ctx.orchConfig.baseBranch}...HEAD`], { cwd: ctx.worktreePath });
    implementationContext = stdout;
  } catch {
    // No diff available (TDD mode) — that's fine
  }

  try {
    for await (const event of runTestWriter({
      backend: ctx.backend,
      cwd: ctx.worktreePath,
      planId: ctx.planId,
      planContent: ctx.planFile.body,
      implementationContext: implementationContext || undefined,
      verbose: ctx.verbose,
      abortController: ctx.abortController,
      ...agentConfig,
    })) {
      tracker.handleEvent(event);
      yield event;
    }
    tracker.cleanup();
    span.end();
  } catch (err) {
    tracker.cleanup();
    span.error(err as Error);
    if (err instanceof Error && err.name === 'AbortError') throw err;
  }

  // Emit files changed after test writing (non-critical)
  yield* emitFilesChanged(ctx);
});

registerBuildStage('test', async function* testStage(ctx) {
  yield* testStageInner(ctx);
});

async function* testStageInner(ctx: BuildStageContext): AsyncGenerator<EforgeEvent> {
  const agentConfig = resolveAgentConfig('tester', ctx.config);
  const span = ctx.tracing.createSpan('tester', { planId: ctx.planId });
  span.setInput({ planId: ctx.planId });
  const tracker = createToolTracker(span);

  try {
    for await (const event of runTester({
      backend: ctx.backend,
      cwd: ctx.worktreePath,
      planId: ctx.planId,
      planContent: ctx.planFile.body,
      verbose: ctx.verbose,
      abortController: ctx.abortController,
      ...agentConfig,
    })) {
      tracker.handleEvent(event);
      yield event;

      // Convert test issues to review issues for evaluate stage consumption
      if (event.type === 'build:test:complete') {
        ctx.reviewIssues = event.productionIssues.map(testIssueToReviewIssue);
      }
    }
    tracker.cleanup();
    span.end();
  } catch (err) {
    tracker.cleanup();
    span.error(err as Error);
    if (err instanceof Error && err.name === 'AbortError') throw err;
  }
}

registerBuildStage('test-fix', async function* testFixStage(ctx) {
  yield* reviewFixStageInner(ctx);
});

registerBuildStage('test-cycle', async function* testCycleStage(ctx) {
  const maxRounds = ctx.review.maxRounds;
  const strictness = ctx.review.evaluatorStrictness;

  for (let round = 0; round < maxRounds; round++) {
    // 1. Test
    yield* testStageInner(ctx);

    // 2. Break if no production issues
    if (ctx.reviewIssues.length === 0) break;

    // 3. Test-fix (reuses review-fix plumbing)
    yield* reviewFixStageInner(ctx);

    // 4. Evaluate
    yield* evaluateStageInner(ctx, { strictness });
  }
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
    if (stageName === 'plan-review-cycle' || stageName === 'architecture-review-cycle') {
      // Commit plan artifacts before running review cycles
      // (reviewers read committed files)
      if (ctx.plans.length > 0 || ctx.expeditionModules.length > 0) {
        const commitCwd = ctx.planCommitCwd ?? ctx.cwd;
        await commitPlanArtifacts(commitCwd, ctx.planSetName, ctx.cwd, ctx.config.plan.outputDir);
      }
    }
    const stage = getCompileStage(stageName);
    yield* stage(ctx);
    if (ctx.skipped) break;
    i++;
  }
}

/**
 * Run the build pipeline stages for a single plan.
 * Each entry in `profile.build` is either a single stage name (run sequentially)
 * or an array of stage names (run concurrently via `runParallel`).
 * After a parallel group completes, any uncommitted changes are auto-committed.
 */
export async function* runBuildPipeline(
  ctx: BuildStageContext,
): AsyncGenerator<EforgeEvent> {
  yield { timestamp: new Date().toISOString(), type: 'build:start', planId: ctx.planId };

  for (const spec of ctx.build) {
    if (Array.isArray(spec)) {
      // Parallel group — run all stages concurrently
      const tasks: ParallelTask<EforgeEvent>[] = spec.map((stageName) => {
        const stage = getBuildStage(stageName);
        return {
          id: stageName,
          run: () => stage(ctx),
        };
      });
      yield* runParallel(tasks);

      // After parallel group, commit any uncommitted changes (e.g., from doc-update)
      try {
        const { stdout: statusOut } = await exec('git', ['status', '--porcelain'], { cwd: ctx.worktreePath });
        if (statusOut.trim().length > 0) {
          await exec('git', ['add', '-A'], { cwd: ctx.worktreePath });
          await forgeCommit(ctx.worktreePath, `chore(${ctx.planId}): post-parallel-group auto-commit`);
        }
      } catch (err) {
        // Non-critical — best-effort commit, but yield a warning so it's observable
        yield { timestamp: new Date().toISOString(), type: 'plan:progress', message: `post-parallel-group auto-commit failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    } else {
      // Sequential stage
      const stage = getBuildStage(spec);
      yield* stage(ctx);
    }

    // Stop pipeline if a stage signaled failure (e.g., implement stage)
    if (ctx.buildFailed) return;
  }

  yield { timestamp: new Date().toISOString(), type: 'build:complete', planId: ctx.planId };
}

/**
 * Commit plan artifacts to git (required for worktree-based builds).
 * @param commitCwd - Working directory for git operations (may differ from plan file location)
 * @param planSetName - Name of the plan set
 * @param planFilesCwd - Optional directory where plan files live (defaults to commitCwd)
 */
async function commitPlanArtifacts(commitCwd: string, planSetName: string, planFilesCwd?: string, outputDir?: string): Promise<void> {
  const planDir = resolve(planFilesCwd ?? commitCwd, outputDir ?? 'eforge/plans', planSetName);
  await exec('git', ['add', planDir], { cwd: commitCwd });
  // Guard: only commit if there are staged changes (prevents "nothing to commit" errors
  // when artifacts were already committed by a previous continuation checkpoint)
  const { stdout: staged } = await exec('git', ['diff', '--cached', '--name-only'], { cwd: commitCwd });
  if (staged.trim().length === 0) return;
  await forgeCommit(commitCwd, `plan(${planSetName}): initial planning artifacts`);
}

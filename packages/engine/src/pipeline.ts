/**
 * Pipeline — named stages with a uniform interface, driven by dynamically composed pipelines.
 *
 * Pipeline stages are named units: each accepts a context and yields EforgeEvents.
 * The engine iterates the stage list from the composed pipeline and calls each stage
 * in sequence. Pipeline composition is a pre-pipeline step handled by the engine.
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
import type { EforgeConfig, BuildStageSpec, ReviewProfileConfig, ModelClass } from './config.js';
import { DEFAULT_REVIEW, MODEL_CLASSES } from './config.js';
import type { PipelineComposition } from './schemas.js';
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
import { composePipeline } from './agents/pipeline-composer.js';
import { runTestWriter, runTester } from './agents/tester.js';
import { compileExpedition } from './compiler.js';
import { resolveDependencyGraph, injectPipelineIntoOrchestrationYaml, parseOrchestrationConfig, writePlanArtifacts, extractPlanTitle, detectValidationCommands, parsePlanFile } from './plan.js';
import { runParallel, type ParallelTask } from './concurrency.js';
import { forgeCommit } from './git.js';

const exec = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PipelineContext {
  backend: AgentBackend;
  config: EforgeConfig;
  pipeline: PipelineComposition;
  tracing: TracingContext;
  cwd: string;
  planSetName: string;
  sourceContent: string;
  verbose?: boolean;
  auto?: boolean;
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
  /** Per-plan build stage sequence (resolved from per-plan config or pipeline fallback). */
  build: BuildStageSpec[];
  /** Per-plan review config (resolved from per-plan config or pipeline fallback). */
  review: ReviewProfileConfig;
  /** Set to true by the implement stage on failure — signals the pipeline runner to stop. */
  buildFailed?: boolean;
  /** Commit SHA captured before the implement stage runs — used as reset target by the evaluator. */
  preImplementCommit?: string;
}

export type CompileStage = (ctx: PipelineContext) => AsyncGenerator<EforgeEvent>;
export type BuildStage = (ctx: BuildStageContext) => AsyncGenerator<EforgeEvent>;

/** Phase a stage belongs to. */
export type StagePhase = 'compile' | 'build';

/** Rich metadata describing a pipeline stage for downstream consumers (e.g., pipeline composer). */
export interface StageDescriptor {
  /** Unique stage name (must match the registration key). */
  name: string;
  /** Which pipeline phase this stage belongs to. */
  phase: StagePhase;
  /** Human-readable description of what the stage does. */
  description: string;
  /** Guidance for when this stage should be included in a pipeline. */
  whenToUse: string;
  /** Rough cost hint: 'low', 'medium', or 'high'. */
  costHint: 'low' | 'medium' | 'high';
  /** Stage names that must appear before this stage in the pipeline (same phase). */
  predecessors?: string[];
  /** Stage names that conflict with this stage (cannot both appear). */
  conflictsWith?: string[];
  /** Whether this stage can run in a parallel group with other stages. Defaults to true. */
  parallelizable?: boolean;
}

// ---------------------------------------------------------------------------
// Stage Registry
// ---------------------------------------------------------------------------

const compileStages = new Map<string, { fn: CompileStage; descriptor: StageDescriptor }>();
const buildStages = new Map<string, { fn: BuildStage; descriptor: StageDescriptor }>();

export function registerCompileStage(descriptor: StageDescriptor, stage: CompileStage): void {
  compileStages.set(descriptor.name, { fn: stage, descriptor });
}

export function registerBuildStage(descriptor: StageDescriptor, stage: BuildStage): void {
  buildStages.set(descriptor.name, { fn: stage, descriptor });
}

export function getCompileStage(name: string): CompileStage {
  const entry = compileStages.get(name);
  if (!entry) throw new Error(`Unknown compile stage: "${name}"`);
  return entry.fn;
}

export function getBuildStage(name: string): BuildStage {
  const entry = buildStages.get(name);
  if (!entry) throw new Error(`Unknown build stage: "${name}"`);
  return entry.fn;
}

/** Return the set of registered compile stage names (for pipeline validation). */
export function getCompileStageNames(): Set<string> {
  return new Set(compileStages.keys());
}

/** Return the set of registered build stage names (for pipeline validation). */
export function getBuildStageNames(): Set<string> {
  return new Set(buildStages.keys());
}

/** Return all registered compile stage descriptors. */
export function getCompileStageDescriptors(): StageDescriptor[] {
  return Array.from(compileStages.values()).map((entry) => entry.descriptor);
}

/** Return all registered build stage descriptors. */
export function getBuildStageDescriptors(): StageDescriptor[] {
  return Array.from(buildStages.values()).map((entry) => entry.descriptor);
}

/** Validate a pipeline configuration against registered stage descriptors. */
export function validatePipeline(
  compile: string[],
  build: Array<string | string[]>,
): { valid: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Flatten build specs for validation
  const flatBuild: string[] = build.flatMap((spec) => (Array.isArray(spec) ? spec : [spec]));

  // Check existence
  for (const name of compile) {
    if (!compileStages.has(name)) {
      errors.push(`Unknown compile stage: "${name}"`);
    }
  }
  for (const name of flatBuild) {
    if (!buildStages.has(name)) {
      errors.push(`Unknown build stage: "${name}"`);
    }
  }

  // Check predecessor ordering (compile)
  for (let i = 0; i < compile.length; i++) {
    const entry = compileStages.get(compile[i]);
    if (!entry) continue;
    const { predecessors } = entry.descriptor;
    if (!predecessors) continue;
    const preceding = new Set(compile.slice(0, i));
    for (const pred of predecessors) {
      if (!preceding.has(pred)) {
        errors.push(`Compile stage "${compile[i]}" requires predecessor "${pred}" to appear before it`);
      }
    }
  }

  // Build a map of stage name → set of parallel peers (other stages in the same group)
  const parallelPeers = new Map<string, Set<string>>();
  for (const spec of build) {
    if (Array.isArray(spec) && spec.length > 1) {
      for (const name of spec) {
        const peers = new Set(spec.filter((s) => s !== name));
        parallelPeers.set(name, peers);
      }
    }
  }

  // Check predecessor ordering (build - using flattened order)
  for (let i = 0; i < flatBuild.length; i++) {
    const entry = buildStages.get(flatBuild[i]);
    if (!entry) continue;
    const { predecessors } = entry.descriptor;
    if (!predecessors) continue;
    const preceding = new Set(flatBuild.slice(0, i));
    const peers = parallelPeers.get(flatBuild[i]);
    for (const pred of predecessors) {
      if (peers?.has(pred)) {
        // Predecessor is in the same parallel group — dependency won't be honored
        errors.push(`Build stage "${flatBuild[i]}" requires predecessor "${pred}" but both are in the same parallel group`);
      } else if (!preceding.has(pred)) {
        errors.push(`Build stage "${flatBuild[i]}" requires predecessor "${pred}" to appear before it`);
      }
    }
  }

  // Check conflicts (deduplicate symmetric pairs like A↔B)
  const allCompile = new Set(compile);
  const allBuild = new Set(flatBuild);
  const seenConflicts = new Set<string>();

  for (const name of compile) {
    const entry = compileStages.get(name);
    if (!entry?.descriptor.conflictsWith) continue;
    for (const conflict of entry.descriptor.conflictsWith) {
      if (allCompile.has(conflict)) {
        const key = [name, conflict].sort().join('::');
        if (!seenConflicts.has(key)) {
          seenConflicts.add(key);
          errors.push(`Compile stage "${name}" conflicts with "${conflict}"`);
        }
      }
    }
  }

  for (const name of flatBuild) {
    const entry = buildStages.get(name);
    if (!entry?.descriptor.conflictsWith) continue;
    for (const conflict of entry.descriptor.conflictsWith) {
      if (allBuild.has(conflict)) {
        const key = [name, conflict].sort().join('::');
        if (!seenConflicts.has(key)) {
          seenConflicts.add(key);
          errors.push(`Build stage "${name}" conflicts with "${conflict}"`);
        }
      }
    }
  }

  // Check parallelizability
  for (const spec of build) {
    if (!Array.isArray(spec)) continue;
    for (const name of spec) {
      const entry = buildStages.get(name);
      if (!entry) continue;
      if (entry.descriptor.parallelizable === false) {
        warnings.push(`Build stage "${name}" is not parallelizable but appears in a parallel group`);
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

/** Format the full stage registry as a markdown table for prompt injection. */
export function formatStageRegistry(): string {
  const allDescriptors = [
    ...getCompileStageDescriptors(),
    ...getBuildStageDescriptors(),
  ];

  const lines: string[] = [
    '| Name | Phase | Description | When to Use | Cost | Predecessors | Conflicts | Parallelizable |',
    '|------|-------|-------------|-------------|------|--------------|-----------|----------------|',
  ];

  for (const d of allDescriptors) {
    const preds = d.predecessors?.join(', ') || '-';
    const conflicts = d.conflictsWith?.join(', ') || '-';
    const parallel = d.parallelizable === false ? 'No' : 'Yes';
    lines.push(`| ${d.name} | ${d.phase} | ${d.description} | ${d.whenToUse} | ${d.costHint} | ${preds} | ${conflicts} | ${parallel} |`);
  }

  return lines.join('\n');
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
  'gap-closer': { maxTurns: 20 },
};

/** Per-role default maxContinuations for agents that support continuation loops. */
export const AGENT_MAX_CONTINUATIONS_DEFAULTS: Partial<Record<AgentRole, number>> = {
  planner: 2,
  evaluator: 1,
  'plan-evaluator': 1,
  'cohesion-evaluator': 1,
  'architecture-evaluator': 1,
};

// ---------------------------------------------------------------------------
// Model Class System
// ---------------------------------------------------------------------------

/** Maps each agent role to its default model class. */
export const AGENT_MODEL_CLASSES: Record<AgentRole, ModelClass> = {
  planner: 'max',
  'architecture-reviewer': 'max',
  'architecture-evaluator': 'max',
  'cohesion-reviewer': 'max',
  'cohesion-evaluator': 'max',
  'module-planner': 'max',
  'plan-reviewer': 'max',
  'plan-evaluator': 'max',
  builder: 'max',
  reviewer: 'max',
  'review-fixer': 'max',
  evaluator: 'max',
  'validation-fixer': 'max',
  'merge-conflict-resolver': 'max',
  'doc-updater': 'max',
  'test-writer': 'max',
  tester: 'max',
  formatter: 'max',
  'staleness-assessor': 'balanced',
  'prd-validator': 'balanced',
  'dependency-detector': 'balanced',
  'pipeline-composer': 'max',
  'gap-closer': 'max',
};

/** Per-backend default ModelRef objects for each model class. `undefined` means the SDK picks its own model. */
export const MODEL_CLASS_DEFAULTS: Record<string, Record<ModelClass, import('./config.js').ModelRef | undefined>> = {
  'claude-sdk': {
    max: { id: 'claude-opus-4-6' },
    balanced: { id: 'claude-sonnet-4-6' },
    fast: { id: 'claude-haiku-4-5' },
  },
  pi: {
    max: undefined,
    balanced: undefined,
    fast: undefined,
  },
};

/** Ordered tier list for fallback resolution: index 0 is the most capable. */
const MODEL_CLASS_TIER: ModelClass[] = ['max', 'balanced', 'fast'];

/**
 * Resolve agent config for a given role.
 * Five-tier model resolution (highest → lowest):
 *   1. User per-role model (config.agents.roles[role].model)
 *   2. User global model (config.agents.model)
 *   3. User model class override (config.agents.models[effectiveClass])
 *   4. Backend model class default (MODEL_CLASS_DEFAULTS[backend][effectiveClass])
 *   5. undefined (no model set)
 *
 * Effective class is determined by: per-role modelClass > built-in AGENT_MODEL_CLASSES[role].
 *
 * Other fields use the existing four-tier priority:
 *   1. User per-role config (config.agents.roles[role])
 *   2. User global config (config.agents.{thinking,effort,...}, config.agents.maxTurns)
 *   3. Built-in per-role defaults (AGENT_ROLE_DEFAULTS[role])
 *   4. Built-in global default (DEFAULT_CONFIG.agents.maxTurns)
 */
export function resolveAgentConfig(
  role: AgentRole,
  config: EforgeConfig,
  backend?: 'claude-sdk' | 'pi',
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
  const SDK_FIELDS = ['thinking', 'effort', 'maxBudgetUsd', 'fallbackModel', 'allowedTools', 'disallowedTools'] as const;

  const result: import('./config.js').ResolvedAgentConfig = {};

  // Resolve maxTurns: user per-role > built-in per-role > user global
  result.maxTurns = userRole.maxTurns ?? builtinRoleDefaults.maxTurns ?? userGlobal.maxTurns;

  // Resolve SDK passthrough fields (excluding model - handled via class system below)
  for (const field of SDK_FIELDS) {
    const value = userRole[field] ?? userGlobal[field] ?? builtinRoleDefaults[field];
    if (value !== undefined) {
      (result as Record<string, unknown>)[field] = value;
    }
  }

  // Resolve model via class system:
  //   per-role model > global model > user class override > backend class default
  const perRoleModel = userRole.model ?? builtinRoleDefaults.model;
  const globalModel = userGlobal.model;
  const effectiveClass: ModelClass = userRole.modelClass ?? AGENT_MODEL_CLASSES[role];

  if (perRoleModel !== undefined) {
    result.model = perRoleModel;
  } else if (globalModel !== undefined) {
    result.model = globalModel;
  } else {
    // Check user-configured class model overrides
    const userClassModel = config.agents.models?.[effectiveClass];
    if (userClassModel !== undefined) {
      result.model = userClassModel;
    } else {
      // Fall back to backend defaults (skip when backend is undefined)
      if (backend) {
        const backendDefaults = MODEL_CLASS_DEFAULTS[backend];
        if (backendDefaults) {
          result.model = backendDefaults[effectiveClass];
        }
      }
    }

    // Fallback chain: if model is still undefined, walk tiers ascending then descending
    if (result.model === undefined && backend !== undefined) {
      const effectiveIdx = MODEL_CLASS_TIER.indexOf(effectiveClass);
      const attempted: ModelClass[] = [];

      // Ascending (toward more capable): indices < effectiveIdx
      for (let i = effectiveIdx - 1; i >= 0; i--) {
        const tier = MODEL_CLASS_TIER[i];
        attempted.push(tier);
        const userModel = config.agents.models?.[tier];
        if (userModel !== undefined) {
          result.model = userModel;
          result.fallbackFrom = effectiveClass;
          break;
        }
        const backendModel = MODEL_CLASS_DEFAULTS[backend]?.[tier];
        if (backendModel !== undefined) {
          result.model = backendModel;
          result.fallbackFrom = effectiveClass;
          break;
        }
      }

      // Descending (toward less capable): indices > effectiveIdx
      if (result.model === undefined) {
        for (let i = effectiveIdx + 1; i < MODEL_CLASS_TIER.length; i++) {
          const tier = MODEL_CLASS_TIER[i];
          attempted.push(tier);
          const userModel = config.agents.models?.[tier];
          if (userModel !== undefined) {
            result.model = userModel;
            result.fallbackFrom = effectiveClass;
            break;
          }
          const backendModel = MODEL_CLASS_DEFAULTS[backend]?.[tier];
          if (backendModel !== undefined) {
            result.model = backendModel;
            result.fallbackFrom = effectiveClass;
            break;
          }
        }
      }

      // If still undefined after fallback, throw for non-claude-sdk backends
      if (result.model === undefined && backend !== 'claude-sdk') {
        throw new Error(
          `No model configured for role "${role}" (model class "${effectiveClass}") on backend "${backend}". ` +
          `Tried fallback: ${attempted.join(', ')}. ` +
          `Set agents.models.${effectiveClass} in eforge/config.yaml.`,
        );
      }
    }
  }

  // Backends without built-in defaults require the user to configure model mappings.
  // claude-sdk is exempt because undefined means "SDK picks based on subscription".
  // (This check is now only reached when no fallback chain was attempted, i.e. backend is undefined)
  if (result.model === undefined && backend !== 'claude-sdk' && backend !== undefined) {
    throw new Error(
      `No model configured for role "${role}" (model class "${effectiveClass}") on backend "${backend}". ` +
      `Set agents.models.${effectiveClass} in eforge/config.yaml.`,
    );
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

registerCompileStage({
  name: 'prd-passthrough',
  phase: 'compile',
  description: 'Converts a PRD directly into plan artifacts without LLM planning.',
  whenToUse: 'For small, well-defined tasks where the PRD itself serves as the implementation plan.',
  costHint: 'low',
  conflictsWith: ['planner'],
  parallelizable: false,
}, async function* prdPassthroughStage(ctx) {
  yield { timestamp: new Date().toISOString(), type: 'plan:start', source: ctx.sourceContent, label: 'prd-passthrough' };

  // Extract title and body from PRD
  const { title, body } = extractPrdMetadata(ctx.sourceContent, ctx.planSetName);

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
    pipeline: ctx.pipeline,
    validate: validate.length > 0 ? validate : undefined,
    mode: 'errand',
    build: ctx.pipeline.defaultBuild as BuildStageSpec[],
    review: ctx.pipeline.defaultReview as ReviewProfileConfig,
    outputDir: ctx.config.plan.outputDir,
  });

  ctx.plans = [planFile];

  // Commit plan artifacts (prd-passthrough replaces both planner + review,
  // so it must commit its own artifacts for the build phase to create worktrees)
  const commitCwd = ctx.planCommitCwd ?? ctx.cwd;
  const planDir = resolve(ctx.cwd, ctx.config.plan.outputDir, ctx.planSetName);
  await exec('git', ['add', planDir], { cwd: commitCwd });
  // Guard: only commit if there are staged changes (prevents "nothing to commit" errors
  // when artifacts were already committed by a previous run/retry)
  const { stdout: passthroughStaged } = await exec('git', ['diff', '--cached', '--name-only'], { cwd: commitCwd });
  if (passthroughStaged.trim().length > 0) {
    await forgeCommit(commitCwd, `plan(${ctx.planSetName}): PRD passthrough artifacts`);
  }

  yield { timestamp: new Date().toISOString(), type: 'plan:complete', plans: [planFile] };
});

registerCompileStage({
  name: 'planner',
  phase: 'compile',
  description: 'Runs the LLM planner agent to decompose a PRD into implementation plans with dependency graphs.',
  whenToUse: 'For any task that needs LLM-driven planning and decomposition. The default compile entry point.',
  costHint: 'high',
  conflictsWith: ['prd-passthrough'],
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
    if (event.type === 'plan:pipeline') {
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

  // Guard: if the composer replaced the compile pipeline with stages that no
  // longer include 'planner', return early so the new stages can execute.
  if (!ctx.pipeline.compile.includes('planner')) {
    yield { timestamp: new Date().toISOString(), type: 'plan:progress', message: `Pipeline composer selected [${ctx.pipeline.compile.join(', ')}] — delegating to new compile stages.` };
    return;
  }

  const agentConfig = resolveAgentConfig('planner', ctx.config, ctx.config.backend);
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
        abortController: ctx.abortController,
        backend: ctx.backend,
        onClarification: ctx.onClarification,
        scope: ctx.pipeline.scope,
        outputDir: ctx.config.plan.outputDir,
        ...agentConfig,
        continuationContext,
      })) {
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

        // Track final plans for review phase and inject pipeline into orchestration.yaml
        if (event.type === 'plan:complete') {
          const orchYamlPath = resolve(ctx.cwd, ctx.config.plan.outputDir, ctx.planSetName, 'orchestration.yaml');

          // Both injectPipelineIntoOrchestrationYaml() and parseOrchestrationConfig() read
          // orchestration.yaml from disk. If the planner failed to write it, the file won't
          // exist and either call would throw ENOENT. Wrap both in the same try/catch so we
          // fall through to yield the original unenriched plans on any failure.
          try {
            // Inject the pipeline composition (and correct baseBranch) into the planner-written orchestration.yaml.
            // The planner sees the merge worktree's feature branch as HEAD, so base_branch needs overriding.
            await injectPipelineIntoOrchestrationYaml(orchYamlPath, ctx.pipeline, ctx.baseBranch);

            // Backfill dependsOn from orchestration.yaml into plan:complete events.
            // The planner writes depends_on to orchestration.yaml but not to individual
            // plan file frontmatter, so parsePlanFile() returns empty dependsOn arrays.
            // Cross-reference orchestration.yaml to enrich the event.
            const orchConfig = await parseOrchestrationConfig(orchYamlPath);
            const enrichedPlans = backfillDependsOn(event.plans, orchConfig);
            ctx.plans = enrichedPlans;
            yield { ...event, plans: enrichedPlans };
            continue;
          } catch {
            // Graceful fallback - yield the original event unchanged
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
      continuationEventType: 'plan:evaluate:continuation',
    });
  } catch (err) {
    // Plan review failure is non-fatal - plan artifacts are already committed
    yield { timestamp: new Date().toISOString(), type: 'plan:progress', message: `Plan review skipped: ${(err as Error).message}` };
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
      continuationEventType: 'plan:architecture:evaluate:continuation',
    });
  } catch (err) {
    yield { timestamp: new Date().toISOString(), type: 'plan:progress', message: `Architecture review skipped: ${(err as Error).message}` };
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

  const backend = ctx.backend;
  const onClarification = ctx.onClarification;
  const verbose = ctx.verbose;
  const abortController = ctx.abortController;
  const tracing = ctx.tracing;
  const sourceContent = ctx.sourceContent;
  const planSetName = ctx.planSetName;
  const agentConfig = resolveAgentConfig('module-planner', ctx.config, ctx.config.backend);

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
      continuationEventType: 'plan:cohesion:evaluate:continuation',
    });
  } catch (err) {
    yield { timestamp: new Date().toISOString(), type: 'plan:progress', message: `Cohesion review skipped: ${(err as Error).message}` };
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
  const profileForCompiler = {
    description: ctx.pipeline.rationale,
    compile: ctx.pipeline.compile,
  };
  const plans = await compileExpedition(ctx.cwd, ctx.planSetName, profileForCompiler, ctx.moduleBuildConfigs, ctx.config.plan.outputDir);
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

/** Interval (ms) between periodic file-change checks during long-running build stages. */
export const FILE_CHECK_INTERVAL_MS = 15_000;

/** Compare two sorted string arrays for equality. */
function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Capture per-file diffs between the working tree and a base branch.
 * Runs a single `git diff <baseBranch>` and splits the output on `diff --git a/` headers.
 * Returns an empty array on failure (non-critical).
 */
export async function captureFileDiffs(cwd: string, baseBranch: string): Promise<Array<{ path: string; diff: string }>> {
  try {
    const { stdout } = await exec('git', ['diff', baseBranch], { cwd });
    if (!stdout.trim()) return [];

    const chunks = stdout.split(/(?=^diff --git a\/)/m).filter(Boolean);
    return chunks.map((chunk) => {
      // Extract path from "diff --git a/<path> b/<path>"
      const match = chunk.match(/^diff --git a\/(.+?) b\//);
      const path = match?.[1] ?? 'unknown';
      return { path, diff: chunk };
    });
  } catch {
    return [];
  }
}

/**
 * Wrap an inner agent async generator to periodically check for file changes
 * and interleave `build:files_changed` events. Uses `Promise.race` between
 * the next agent event and a timer so checks happen even during long agent turns.
 *
 * Non-critical — silently skips on git failure. Deduplicates by comparing sorted file lists.
 */
export async function* withPeriodicFileCheck(
  inner: AsyncGenerator<EforgeEvent>,
  ctx: BuildStageContext,
  intervalMs: number = FILE_CHECK_INTERVAL_MS,
): AsyncGenerator<EforgeEvent> {
  const iterator = inner[Symbol.asyncIterator]();
  let lastFiles: string[] = [];
  let pending: Promise<IteratorResult<EforgeEvent>> | null = null;

  try {
    while (true) {
      if (!pending) {
        pending = iterator.next();
      }

      // Race between the next agent event and a timer
      let timerId: ReturnType<typeof setTimeout>;
      const timer = new Promise<'tick'>((resolve) => {
        timerId = setTimeout(() => resolve('tick'), intervalMs);
        timerId.unref();
      });

      const result = await Promise.race([
        pending.then((r) => ({ kind: 'event' as const, result: r })),
        timer.then((t) => ({ kind: t })),
      ]);

      if (result.kind === 'tick') {
        // Timer fired — check for file changes
        try {
          const { stdout } = await exec('git', ['diff', '--name-only', ctx.orchConfig.baseBranch], { cwd: ctx.worktreePath });
          const files = stdout.trim().split('\n').filter(Boolean).sort();
          if (files.length > 0 && !arraysEqual(files, lastFiles)) {
            lastFiles = files;
            const diffs = await captureFileDiffs(ctx.worktreePath, ctx.orchConfig.baseBranch);
            yield { timestamp: new Date().toISOString(), type: 'build:files_changed', planId: ctx.planId, files, diffs, baseBranch: ctx.orchConfig.baseBranch };
          }
        } catch {
          // Non-critical — skip silently
        }
        continue;
      }

      // Agent event arrived — clear the losing timer to avoid accumulating pending callbacks
      clearTimeout(timerId!);
      const { result: iterResult } = result;
      pending = null;

      if (iterResult.done) break;
      yield iterResult.value;
    }
  } finally {
    await iterator.return?.(undefined);
  }
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
      const diffs = await captureFileDiffs(ctx.worktreePath, ctx.orchConfig.baseBranch);
      yield { timestamp: new Date().toISOString(), type: 'build:files_changed', planId: ctx.planId, files, diffs, baseBranch: ctx.orchConfig.baseBranch };
    }
  } catch {
    // Non-critical - skip silently
  }
}

registerBuildStage({
  name: 'implement',
  phase: 'build',
  description: 'Runs the builder agent to implement the plan in a worktree with continuation support.',
  whenToUse: 'Always included as the first build stage. This is where actual code changes are made.',
  costHint: 'high',
  parallelizable: false,
}, async function* implementStage(ctx) {
  // Capture the current HEAD before the builder commits — used by the evaluator as reset target
  try {
    const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd: ctx.worktreePath });
    ctx.preImplementCommit = stdout.trim();
  } catch {
    // Fresh repo or no commits — evaluator will fall back to HEAD~1
  }

  const agentConfig = resolveAgentConfig('builder', ctx.config, ctx.config.backend);

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
      for await (const event of withPeriodicFileCheck(builderImplement(ctx.planFile, {
        backend: ctx.backend,
        cwd: ctx.worktreePath,
        verbose: ctx.verbose,
        abortController: ctx.abortController,
        ...agentConfig,
        parallelStages,
        verificationScope,
        continuationContext,
      }), ctx)) {
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

registerBuildStage({
  name: 'review',
  phase: 'build',
  description: 'Runs a single code review pass identifying issues in the implementation.',
  whenToUse: 'When a single review pass is sufficient. For iterative review-fix cycles, use review-cycle instead.',
  costHint: 'medium',
  predecessors: ['implement'],
}, async function* reviewStage(ctx) {
  yield* reviewStageInner(ctx);
});

async function* reviewStageInner(
  ctx: BuildStageContext,
  overrides?: { strategy?: 'auto' | 'single' | 'parallel'; perspectives?: string[] },
): AsyncGenerator<EforgeEvent> {
  const strategy = overrides?.strategy ?? ctx.review.strategy;
  const perspectives = overrides?.perspectives ?? (ctx.review.perspectives.length > 0 ? ctx.review.perspectives : undefined);
  const reviewerAgentConfig = resolveAgentConfig('reviewer', ctx.config, ctx.config.backend);

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

registerBuildStage({
  name: 'evaluate',
  phase: 'build',
  description: 'Evaluates unstaged changes from review/fixer, accepting or rejecting each change.',
  whenToUse: 'After review-fix to gate which reviewer suggestions are kept. Used within review-cycle.',
  costHint: 'medium',
  predecessors: ['implement'],
}, async function* evaluateStage(ctx) {
  yield* evaluateStageInner(ctx);
});

async function* evaluateStageInner(
  ctx: BuildStageContext,
  overrides?: { strictness?: 'strict' | 'standard' | 'lenient' },
): AsyncGenerator<EforgeEvent> {
  // Only runs if there are unstaged changes from review/fixer
  if (!(await hasUnstagedChanges(ctx.worktreePath))) return;

  const strictness = overrides?.strictness ?? ctx.review.evaluatorStrictness;
  const evalAgentConfig = resolveAgentConfig('evaluator', ctx.config, ctx.config.backend);
  const maxContinuations = AGENT_MAX_CONTINUATIONS_DEFAULTS['evaluator'] ?? 0;

  for (let attempt = 0; attempt <= maxContinuations; attempt++) {
    const evalSpan = ctx.tracing.createSpan('evaluator', { planId: ctx.planId, ...(attempt > 0 && { attempt }) });
    evalSpan.setInput({ planId: ctx.planId, ...(attempt > 0 && { attempt }) });
    const evalTracker = createToolTracker(evalSpan);

    let evaluatorContinuationContext: { attempt: number; maxContinuations: number } | undefined;
    if (attempt > 0) {
      evaluatorContinuationContext = { attempt, maxContinuations };
    }

    try {
      for await (const event of builderEvaluate(ctx.planFile, {
        backend: ctx.backend,
        cwd: ctx.worktreePath,
        verbose: ctx.verbose,
        abortController: ctx.abortController,
        ...evalAgentConfig,
        strictness,
        evaluatorContinuationContext,
        preImplementCommit: ctx.preImplementCommit,
      })) {
        evalTracker.handleEvent(event);
        yield event;
      }
      evalTracker.cleanup();
      evalSpan.end();
      break; // Success — exit loop
    } catch (err) {
      evalTracker.cleanup();

      const isMaxTurns = (err as Error).message.includes('error_max_turns');
      if (isMaxTurns && attempt < maxContinuations) {
        // Check if there are still unstaged changes to process
        if (!(await hasUnstagedChanges(ctx.worktreePath))) {
          // All files processed — treat as success
          evalSpan.end();
          break;
        }
        evalSpan.end();
        yield { timestamp: new Date().toISOString(), type: 'build:evaluate:continuation', planId: ctx.planId, attempt: attempt + 1, maxContinuations } as EforgeEvent;
        continue;
      }

      evalSpan.error(err as Error);
      // Yield build:failed so the pipeline knows evaluation did not complete
      // (builderEvaluate re-throws error_max_turns instead of yielding build:failed)
      if (isMaxTurns) {
        yield { timestamp: new Date().toISOString(), type: 'build:failed', planId: ctx.planId, error: (err as Error).message } as EforgeEvent;
      }
      break; // Non-max_turns error or exhausted continuations
    }
  }
}

registerBuildStage({
  name: 'review-fix',
  phase: 'build',
  description: 'Applies fixes for review issues identified by the reviewer agent.',
  whenToUse: 'After review to fix identified issues. Typically used within review-cycle rather than standalone.',
  costHint: 'medium',
  predecessors: ['implement'],
}, async function* reviewFixStage(ctx) {
  yield* reviewFixStageInner(ctx);
});

async function* reviewFixStageInner(
  ctx: BuildStageContext,
): AsyncGenerator<EforgeEvent> {
  if (ctx.reviewIssues.length === 0) return;

  const fixerConfig = resolveAgentConfig('review-fixer', ctx.config, ctx.config.backend);
  const fixSpan = ctx.tracing.createSpan('review-fixer', { planId: ctx.planId });
  fixSpan.setInput({ planId: ctx.planId, issueCount: ctx.reviewIssues.length });
  const fixTracker = createToolTracker(fixSpan);

  try {
    for await (const event of withPeriodicFileCheck(runReviewFixer({
      backend: ctx.backend,
      planId: ctx.planId,
      cwd: ctx.worktreePath,
      issues: ctx.reviewIssues,
      verbose: ctx.verbose,
      abortController: ctx.abortController,
      ...fixerConfig,
    }), ctx)) {
      fixTracker.handleEvent(event);
      yield event;
    }
    fixTracker.cleanup();
    fixSpan.end();
  } catch (err) {
    fixTracker.cleanup();
    fixSpan.error(err as Error);
    // Re-throw abort errors so the pipeline can respect cancellation
    if (err instanceof Error && err.name === 'AbortError') throw err;
    // Review fixer failures are non-fatal
  }
}

registerBuildStage({
  name: 'review-cycle',
  phase: 'build',
  description: 'Runs iterative review-fix-evaluate rounds up to maxRounds, stopping when no actionable issues remain.',
  whenToUse: 'For quality-critical implementations. Combines review, review-fix, and evaluate into an iterative loop.',
  costHint: 'high',
  predecessors: ['implement'],
  conflictsWith: ['review'],
  parallelizable: false,
}, async function* reviewCycleStage(ctx) {
  const maxRounds = ctx.review.maxRounds;
  const strategy = ctx.review.strategy;
  const perspectives = ctx.review.perspectives.length > 0 ? ctx.review.perspectives : undefined;
  const autoAcceptBelow = ctx.review.autoAcceptBelow;
  const strictness = ctx.review.evaluatorStrictness;

  for (let round = 0; round < maxRounds; round++) {
    // 1. Review (reviewer identifies issues, does not write fixes)
    yield* reviewStageInner(ctx, { strategy, perspectives });

    // 2. Filter issues
    const { filtered } = filterIssuesBySeverity(ctx.reviewIssues, autoAcceptBelow);
    ctx.reviewIssues = filtered;

    if (filtered.length === 0) break; // No actionable issues

    // 3. Review-fix (apply fixes from aggregated issues)
    yield* reviewFixStageInner(ctx);

    // 4. Evaluate
    yield* evaluateStageInner(ctx, { strictness });
  }
});

registerBuildStage({
  name: 'validate',
  phase: 'build',
  description: 'Placeholder for inline validation. Custom pipelines can include this for pre-merge checks.',
  whenToUse: 'When inline validation is needed before merge. Post-merge validation is handled by the Orchestrator.',
  costHint: 'low',
  predecessors: ['implement'],
}, async function* validateStage(_ctx) {
  // Placeholder for inline validation (not used in default pipelines).
  // Post-merge validation continues to be handled by the Orchestrator.
  // Custom pipelines can include this stage for inline validation.
});

registerBuildStage({
  name: 'doc-update',
  phase: 'build',
  description: 'Updates project documentation to reflect implementation changes.',
  whenToUse: 'After implementation to keep docs in sync. Can run in parallel with review stages.',
  costHint: 'medium',
  predecessors: ['implement'],
}, async function* docUpdateStage(ctx) {
  const agentConfig = resolveAgentConfig('doc-updater', ctx.config, ctx.config.backend);
  const docSpan = ctx.tracing.createSpan('doc-updater', { planId: ctx.planId });
  docSpan.setInput({ planId: ctx.planId });
  const docTracker = createToolTracker(docSpan);

  try {
    for await (const event of withPeriodicFileCheck(runDocUpdater({
      backend: ctx.backend,
      cwd: ctx.worktreePath,
      planId: ctx.planId,
      planContent: ctx.planFile.body,
      verbose: ctx.verbose,
      abortController: ctx.abortController,
      ...agentConfig,
    }), ctx)) {
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

registerBuildStage({
  name: 'test-write',
  phase: 'build',
  description: 'Writes test cases for the implementation using the test-writer agent.',
  whenToUse: 'When automated test generation is desired. Can run after or in parallel with implementation.',
  costHint: 'medium',
  predecessors: ['implement'],
}, async function* testWriteStage(ctx) {
  const agentConfig = resolveAgentConfig('test-writer', ctx.config, ctx.config.backend);
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
    for await (const event of withPeriodicFileCheck(runTestWriter({
      backend: ctx.backend,
      cwd: ctx.worktreePath,
      planId: ctx.planId,
      planContent: ctx.planFile.body,
      implementationContext: implementationContext || undefined,
      verbose: ctx.verbose,
      abortController: ctx.abortController,
      ...agentConfig,
    }), ctx)) {
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

registerBuildStage({
  name: 'test',
  phase: 'build',
  description: 'Runs the tester agent to execute tests and identify production code issues.',
  whenToUse: 'When test execution and production issue detection is needed. Used within test-cycle.',
  costHint: 'medium',
  predecessors: ['implement'],
}, async function* testStage(ctx) {
  yield* testStageInner(ctx);
});

async function* testStageInner(ctx: BuildStageContext): AsyncGenerator<EforgeEvent> {
  const agentConfig = resolveAgentConfig('tester', ctx.config, ctx.config.backend);
  const span = ctx.tracing.createSpan('tester', { planId: ctx.planId });
  span.setInput({ planId: ctx.planId });
  const tracker = createToolTracker(span);

  try {
    for await (const event of withPeriodicFileCheck(runTester({
      backend: ctx.backend,
      cwd: ctx.worktreePath,
      planId: ctx.planId,
      planContent: ctx.planFile.body,
      verbose: ctx.verbose,
      abortController: ctx.abortController,
      ...agentConfig,
    }), ctx)) {
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

registerBuildStage({
  name: 'test-cycle',
  phase: 'build',
  description: 'Runs iterative test-evaluate rounds up to maxRounds, stopping when no production issues remain.',
  whenToUse: 'For test-driven quality assurance. Combines test and evaluate into an iterative loop.',
  costHint: 'high',
  predecessors: ['implement'],
  conflictsWith: ['test'],
  parallelizable: false,
}, async function* testCycleStage(ctx) {
  const maxRounds = ctx.review.maxRounds;
  const strictness = ctx.review.evaluatorStrictness;

  for (let round = 0; round < maxRounds; round++) {
    // 1. Test (tester writes production fixes directly as unstaged changes)
    yield* testStageInner(ctx);

    // 2. Break if no production issues
    if (ctx.reviewIssues.length === 0) break;

    // 3. Evaluate
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
    run: (continuationContext?: { attempt: number; maxContinuations: number }) => AsyncGenerator<EforgeEvent>;
  };
  /** Event type to emit on evaluator continuation. */
  continuationEventType?: EforgeEvent['type'];
}

/**
 * Run a review -> evaluate cycle. The reviewer runs first (non-fatal on error).
 * If the reviewer left unstaged changes, the evaluator runs to accept/reject them.
 * Both phases are traced with Langfuse spans. The evaluator phase supports
 * continuation loops on error_max_turns.
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
    const evalRole = config.evaluator.role as keyof typeof AGENT_MAX_CONTINUATIONS_DEFAULTS;
    const maxContinuations = AGENT_MAX_CONTINUATIONS_DEFAULTS[evalRole] ?? 0;

    for (let attempt = 0; attempt <= maxContinuations; attempt++) {
      const evalSpan = config.tracing.createSpan(config.evaluator.role, { ...config.evaluator.metadata, ...(attempt > 0 && { attempt }) });
      evalSpan.setInput({ ...config.evaluator.metadata, ...(attempt > 0 && { attempt }) });
      const evalTracker = createToolTracker(evalSpan);

      const continuationContext = attempt > 0 ? { attempt, maxContinuations } : undefined;

      try {
        for await (const event of config.evaluator.run(continuationContext)) {
          evalTracker.handleEvent(event);
          yield event;
        }
        evalTracker.cleanup();
        evalSpan.end();
        break; // Success
      } catch (err) {
        evalTracker.cleanup();

        const isMaxTurns = (err as Error).message.includes('error_max_turns');
        if (isMaxTurns && attempt < maxContinuations) {
          // Check if there are still unstaged changes to process
          if (!(await hasUnstagedChanges(config.cwd))) {
            evalSpan.end();
            break; // All files processed
          }
          evalSpan.end();
          if (config.continuationEventType) {
            yield { timestamp: new Date().toISOString(), type: config.continuationEventType, attempt: attempt + 1, maxContinuations } as EforgeEvent;
          }
          continue;
        }

        evalSpan.error(err as Error);
        break; // Non-max_turns error or exhausted continuations
      }
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
  // Index-based iteration: ctx.pipeline may change mid-pipeline (e.g., planner
  // stage switches from excursion to expedition), so re-read ctx.pipeline.compile
  // on each iteration instead of capturing it once via for...of.
  let i = 0;
  let restarts = 0;
  const MAX_RESTARTS = 5;
  while (i < ctx.pipeline.compile.length) {
    const stageName = ctx.pipeline.compile[i];
    if (stageName === 'plan-review-cycle' || stageName === 'architecture-review-cycle') {
      // Commit plan artifacts before running review cycles
      // (reviewers read committed files)
      if (ctx.plans.length > 0 || ctx.expeditionModules.length > 0) {
        const commitCwd = ctx.planCommitCwd ?? ctx.cwd;
        await commitPlanArtifacts(commitCwd, ctx.planSetName, ctx.cwd, ctx.config.plan.outputDir);
      }
    }
    // Snapshot the compile list before running the stage. If the stage mutates
    // ctx.pipeline.compile (e.g., planner delegates to prd-passthrough), we
    // restart the loop from the beginning of the new list.
    const compileBefore = ctx.pipeline.compile;
    const stage = getCompileStage(stageName);
    yield* stage(ctx);
    if (ctx.skipped) break;
    const compileChanged = ctx.pipeline.compile.length !== compileBefore.length ||
      ctx.pipeline.compile.some((s, idx) => s !== compileBefore[idx]);
    if (compileChanged) {
      // Stage replaced the compile list — restart from the beginning
      if (++restarts > MAX_RESTARTS) {
        throw new Error('Compile pipeline restarted too many times — possible infinite loop');
      }
      i = 0;
    } else {
      i++;
    }
  }
}

/**
 * Run the build pipeline stages for a single plan.
 * Each entry in the build pipeline is either a single stage name (run sequentially)
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

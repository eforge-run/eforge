/**
 * EforgeEngine — the sole public API for plan-build-review workflows.
 * All methods return AsyncGenerator<EforgeEvent> (except status() which is synchronous).
 * Engine emits, consumers render — never writes to stdout.
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import type {
  EforgeEvent,
  EforgeStatus,
  CompileOptions,
  BuildOptions,
  AdoptOptions,
  PlanFile,
  ClarificationQuestion,
  AgentResultData,
  AgentRole,
  ExpeditionModule,
  ScopeAssessment,
} from './events.js';
import type { EforgeConfig, PluginConfig } from './config.js';
import type { AgentBackend } from './backend.js';
import type { ClaudeSDKBackendOptions } from './backends/claude-sdk.js';
import type { SdkPluginConfig, SettingSource } from '@anthropic-ai/claude-agent-sdk';
import type { PlannerOptions } from './agents/planner.js';
import { loadConfig } from './config.js';
import { ClaudeSDKBackend } from './backends/claude-sdk.js';
import { createTracingContext, type SpanHandle, type ToolCallHandle, type TracingContext } from './tracing.js';
import { runPlanner } from './agents/planner.js';
import { runModulePlanner } from './agents/module-planner.js';
import { builderImplement, builderEvaluate } from './agents/builder.js';
import { runReview } from './agents/reviewer.js';
import { runPlanReview } from './agents/plan-reviewer.js';
import { runPlanEvaluate } from './agents/plan-evaluator.js';
import { runCohesionReview } from './agents/cohesion-reviewer.js';
import { runCohesionEvaluate } from './agents/cohesion-evaluator.js';
import { runValidationFixer } from './agents/validation-fixer.js';
import { runAssessor } from './agents/assessor.js';
import { Orchestrator, type ValidationFixer } from './orchestrator.js';
import { deriveNameFromSource, deriveNameFromContent, parseOrchestrationConfig, parsePlanFile, validatePlanSet, validatePlanSetName, extractPlanTitle, detectValidationCommands, writePlanArtifacts } from './plan.js';
import { compileExpedition } from './compiler.js';
import { parseModulesBlock } from './agents/common.js';
import { loadState } from './state.js';

const exec = promisify(execFile);

export interface EforgeEngineOptions {
  /** Working directory (defaults to process.cwd()) */
  cwd?: string;
  /** Config overrides (deep-merged with loaded config) */
  config?: Partial<EforgeConfig>;
  /** Agent backend (defaults to ClaudeSDKBackend) */
  backend?: AgentBackend;
  /** MCP servers to make available to agents (Claude SDK backend only, ignored if backend is provided) */
  mcpServers?: ClaudeSDKBackendOptions['mcpServers'];
  /** Claude Code plugins to load (Claude SDK backend only, ignored if backend is provided) */
  plugins?: SdkPluginConfig[];
  /** Which settings sources to load — 'user', 'project', 'local' (Claude SDK backend only) */
  settingSources?: SettingSource[];
  /** Clarification callback for interactive planning */
  onClarification?: (questions: ClarificationQuestion[]) => Promise<Record<string, string>>;
  /** Approval callback for build gates */
  onApproval?: (action: string, details: string) => Promise<boolean>;
}

export class EforgeEngine {
  private readonly config: EforgeConfig;
  private readonly cwd: string;
  private readonly backend: AgentBackend;
  private readonly onClarification?: EforgeEngineOptions['onClarification'];
  private readonly onApproval?: EforgeEngineOptions['onApproval'];

  private constructor(config: EforgeConfig, options: EforgeEngineOptions = {}) {
    this.config = config;
    this.cwd = options.cwd ?? process.cwd();
    this.backend = options.backend ?? new ClaudeSDKBackend({
      mcpServers: options.mcpServers,
      plugins: options.plugins,
      settingSources: options.settingSources ?? config.agents.settingSources as SettingSource[] | undefined,
    });
    this.onClarification = options.onClarification;
    this.onApproval = options.onApproval;
  }

  /** Expose resolved config for CLI diagnostics. */
  get resolvedConfig(): EforgeConfig {
    return this.config;
  }

  /**
   * Async factory — loads config, applies overrides, returns engine.
   * Auto-loads MCP servers from .mcp.json if not explicitly provided.
   */
  static async create(options: EforgeEngineOptions = {}): Promise<EforgeEngine> {
    const cwd = options.cwd ?? process.cwd();
    let config = await loadConfig(cwd);

    if (options.config) {
      config = mergeConfig(config, options.config);
    }

    // Auto-load MCP servers from .mcp.json if not explicitly provided
    if (!options.mcpServers && !options.backend) {
      const discovered = await loadMcpServers(cwd);
      if (discovered) {
        options = { ...options, mcpServers: discovered };
      }
    }

    // Auto-load plugins from ~/.claude/plugins/ if not explicitly provided
    if (!options.plugins && !options.backend) {
      const discovered = await loadPlugins(cwd, config.plugins);
      if (discovered) {
        options = { ...options, plugins: discovered };
      }
    }

    return new EforgeEngine(config, options);
  }

  /**
   * Plan: explore codebase, assess scope, write planning artifacts.
   *
   * The planner explores and assesses scope. Based on the assessment:
   * - errand/excursion: planner generates plan files + orchestration.yaml directly
   * - expedition: planner generates architecture.md + index.yaml + module list,
   *   then engine runs module planners and compiles plan files
   */
  async *compile(source: string, options: Partial<CompileOptions> = {}): AsyncGenerator<EforgeEvent> {
    const runId = randomUUID();
    const planSetName = options.name ?? deriveNameFromSource(source);
    validatePlanSetName(planSetName);
    const tracing = createTracingContext(this.config, runId, 'compile', planSetName);
    const cwd = options.cwd ?? this.cwd;

    yield {
      type: 'phase:start',
      runId,
      planSet: planSetName,
      command: 'compile',
      timestamp: new Date().toISOString(),
    };

    let status: 'completed' | 'failed' = 'completed';
    let summary = 'Compile complete';

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
        backend: this.backend,
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

        // Cohesion review cycle: cross-module validation (expedition only, non-fatal)
        if (scopeAssessment === 'expedition') {
          try {
            // Read architecture content for cohesion reviewer
            let architectureContent = '';
            try {
              architectureContent = await readFile(resolve(cwd, 'plans', planSetName, 'architecture.md'), 'utf-8');
            } catch {
              // Architecture file may not exist
            }

            yield* runReviewCycle({
              tracing,
              cwd,
              reviewer: {
                role: 'cohesion-reviewer',
                metadata: { planSet: planSetName },
                run: () => runCohesionReview({ backend: this.backend, sourceContent, planSetName, architectureContent, cwd, verbose, abortController }),
              },
              evaluator: {
                role: 'cohesion-evaluator',
                metadata: { planSet: planSetName },
                run: () => runCohesionEvaluate({ backend: this.backend, planSetName, sourceContent, cwd, verbose, abortController }),
              },
            });
          } catch (err) {
            // Cohesion review failure is non-fatal — plan artifacts are already committed
            yield { type: 'plan:progress', message: `Cohesion review skipped: ${(err as Error).message}` };
          }
        }

        // Plan review cycle: blind review → evaluate (non-fatal)
        try {
          yield* runReviewCycle({
            tracing,
            cwd,
            reviewer: {
              role: 'plan-reviewer',
              metadata: { planSet: planSetName },
              run: () => runPlanReview({ backend: this.backend, sourceContent, planSetName, cwd, verbose, abortController }),
            },
            evaluator: {
              role: 'plan-evaluator',
              metadata: { planSet: planSetName },
              run: () => runPlanEvaluate({ backend: this.backend, planSetName, sourceContent, cwd, verbose, abortController }),
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
        type: 'phase:end',
        runId,
        result: { status, summary },
        timestamp: new Date().toISOString(),
      };
      await tracing.flush();
    }
  }

  /**
   * Adopt: wrap an existing implementation plan (e.g., from Claude Code plan mode)
   * into eforge plan format. Runs scope assessment first — errands wrap as-is,
   * excursion/expedition delegates to the full planner for proper decomposition.
   */
  async *adopt(source: string, options: Partial<AdoptOptions> = {}): AsyncGenerator<EforgeEvent> {
    const cwd = options.cwd ?? this.cwd;
    const runId = randomUUID();

    // Resolve source content
    let sourceContent: string;
    try {
      const sourcePath = resolve(cwd, source);
      const stats = await stat(sourcePath);
      sourceContent = stats.isFile() ? await readFile(sourcePath, 'utf-8') : source;
    } catch {
      sourceContent = source;
    }

    // Derive plan set name from content H1, fall back to filename
    const planSetName = options.name
      ?? deriveNameFromContent(sourceContent)
      ?? deriveNameFromSource(source);
    validatePlanSetName(planSetName);
    const tracing = createTracingContext(this.config, runId, 'adopt', planSetName);

    yield {
      type: 'phase:start',
      runId,
      planSet: planSetName,
      command: 'adopt',
      timestamp: new Date().toISOString(),
    };

    let status: 'completed' | 'failed' = 'completed';
    let summary = 'Adoption complete';

    tracing.setInput({ source, planSet: planSetName });

    try {
      // Derive plan title from first H1 heading
      const planName = extractPlanTitle(sourceContent)
        ?? planSetName.replace(/-/g, ' ').replace(/\b\w/, (c) => c.toUpperCase());

      // Detect base branch
      let baseBranch = 'main';
      try {
        const { stdout } = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
        baseBranch = stdout.trim();
      } catch {
        // Fall back to main
      }

      // Resolve validation commands
      let validate = options.validate;
      if (!validate || validate.length === 0) {
        validate = this.config.build.postMergeCommands;
      }
      if (!validate || validate.length === 0) {
        validate = await detectValidationCommands(cwd);
      }

      const verbose = options.verbose;
      const abortController = options.abortController;

      yield { type: 'plan:start', source };

      // Run assessor agent to determine scope
      const assessorSpan = tracing.createSpan('assessor', { planSet: planSetName });
      assessorSpan.setInput({ source, planSet: planSetName });
      const assessorTracker = createToolTracker(assessorSpan);

      let scopeAssessment: ScopeAssessment = 'errand';

      try {
        for await (const event of runAssessor({ backend: this.backend, sourceContent, cwd, verbose, abortController })) {
          assessorTracker.handleEvent(event);

          if (event.type === 'plan:scope') {
            scopeAssessment = event.assessment;
          }

          yield event;
        }
        assessorTracker.cleanup();
        assessorSpan.end();
      } catch (err) {
        assessorTracker.cleanup();
        assessorSpan.error(err as Error);
        // On assessor failure, default to errand (safe fallback)
        yield { type: 'plan:scope', assessment: 'errand', justification: `Assessor failed: ${(err as Error).message} — defaulting to errand.` };
      }

      // Branch on scope
      if (scopeAssessment === 'complete') {
        // Nothing to do — source is fully implemented
        yield { type: 'plan:complete', plans: [] };
      } else if (scopeAssessment === 'errand') {
        // Wrap as-is (current behavior)
        yield { type: 'plan:progress', message: `Adopting plan as ${planSetName}...` };

        const planFile = await writePlanArtifacts({
          cwd,
          planSetName,
          sourceContent,
          planName,
          baseBranch,
          validate,
          mode: 'errand',
        });

        // Commit plan artifacts
        const planDir = resolve(cwd, 'plans', planSetName);
        await exec('git', ['add', planDir], { cwd });
        await exec('git', ['commit', '-m', `plan(${planSetName}): adopt existing implementation plan`], { cwd });

        yield { type: 'plan:complete', plans: [planFile] };

        // Plan review cycle (non-fatal, skippable)
        if (!options.skipReview) {
          try {
            yield* runReviewCycle({
              tracing,
              cwd,
              reviewer: {
                role: 'plan-reviewer',
                metadata: { planSet: planSetName },
                run: () => runPlanReview({ backend: this.backend, sourceContent, planSetName, cwd, verbose, abortController }),
              },
              evaluator: {
                role: 'plan-evaluator',
                metadata: { planSet: planSetName },
                run: () => runPlanEvaluate({ backend: this.backend, planSetName, sourceContent, cwd, verbose, abortController }),
              },
            });
          } catch (err) {
            yield { type: 'plan:progress', message: `Plan review skipped: ${(err as Error).message}` };
          }
        }
      } else {
        // excursion or expedition — delegate to the full planner
        yield { type: 'plan:progress', message: `Scope is ${scopeAssessment} — running planner...` };

        let expeditionModules: ExpeditionModule[] = [];
        let finalPlans: PlanFile[] = [];

        for await (const event of runPlanner(source, {
          cwd,
          name: planSetName,
          auto: options.auto,
          backend: this.backend,
          onClarification: this.onClarification,
          verbose,
          abortController,
        })) {
          // Suppress duplicate plan:start and plan:scope (adopt already emitted these)
          if (event.type === 'plan:start' || event.type === 'plan:scope') continue;

          // Detect <modules> block in agent messages (expedition mode, first match only)
          if (event.type === 'agent:message' && event.agent === 'planner' && expeditionModules.length === 0) {
            const modules = parseModulesBlock(event.content);
            if (modules.length > 0) {
              expeditionModules = modules;
              yield { type: 'expedition:architecture:complete', modules };
            }
          }

          // Suppress planner's plan:complete in expedition mode (compilation emits the real one)
          if (event.type === 'plan:complete' && scopeAssessment === 'expedition' && expeditionModules.length > 0) {
            continue;
          }

          // Track final plans
          if (event.type === 'plan:complete') {
            finalPlans = event.plans;
          }

          yield event;
        }

        // Expedition module planning (if needed)
        if (scopeAssessment === 'expedition' && expeditionModules.length > 0) {
          try {
            for await (const event of this.planExpeditionModules(planSetName, expeditionModules, tracing, {
              ...options,
              cwd,
              sourceContent,
            })) {
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

        // Commit plan artifacts
        if (status !== 'failed' && finalPlans.length > 0) {
          const planDir = resolve(cwd, 'plans', planSetName);
          await exec('git', ['add', planDir], { cwd });
          await exec('git', ['commit', '-m', `plan(${planSetName}): adopt existing implementation plan`], { cwd });

          // Cohesion review cycle (expedition only, non-fatal)
          if (scopeAssessment === 'expedition') {
            try {
              let architectureContent = '';
              try {
                architectureContent = await readFile(resolve(cwd, 'plans', planSetName, 'architecture.md'), 'utf-8');
              } catch {
                // Architecture file may not exist
              }

              yield* runReviewCycle({
                tracing,
                cwd,
                reviewer: {
                  role: 'cohesion-reviewer',
                  metadata: { planSet: planSetName },
                  run: () => runCohesionReview({ backend: this.backend, sourceContent, planSetName, architectureContent, cwd, verbose, abortController }),
                },
                evaluator: {
                  role: 'cohesion-evaluator',
                  metadata: { planSet: planSetName },
                  run: () => runCohesionEvaluate({ backend: this.backend, planSetName, sourceContent, cwd, verbose, abortController }),
                },
              });
            } catch (err) {
              yield { type: 'plan:progress', message: `Cohesion review skipped: ${(err as Error).message}` };
            }
          }

          // Plan review cycle (non-fatal, skippable)
          if (!options.skipReview) {
            try {
              yield* runReviewCycle({
                tracing,
                cwd,
                reviewer: {
                  role: 'plan-reviewer',
                  metadata: { planSet: planSetName },
                  run: () => runPlanReview({ backend: this.backend, sourceContent, planSetName, cwd, verbose, abortController }),
                },
                evaluator: {
                  role: 'plan-evaluator',
                  metadata: { planSet: planSetName },
                  run: () => runPlanEvaluate({ backend: this.backend, planSetName, sourceContent, cwd, verbose, abortController }),
                },
              });
            } catch (err) {
              yield { type: 'plan:progress', message: `Plan review skipped: ${(err as Error).message}` };
            }
          }
        }
      }
    } catch (err) {
      status = 'failed';
      summary = (err as Error).message;
    } finally {
      tracing.setOutput({ status, summary });
      yield {
        type: 'phase:end',
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
    options: Partial<CompileOptions> & { cwd: string; sourceContent: string },
  ): AsyncGenerator<EforgeEvent> {
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
          backend: this.backend,
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
  async *build(planSet: string, options: Partial<BuildOptions> = {}): AsyncGenerator<EforgeEvent> {
    validatePlanSetName(planSet);
    const runId = randomUUID();
    const tracing = createTracingContext(this.config, runId, 'build', planSet);
    const cwd = options.cwd ?? this.cwd;

    yield {
      type: 'phase:start',
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
      const backend = this.backend;
      const verbose = options.verbose;
      const abortController = options.abortController;

      const planRunner = async function* (
        planId: string,
        worktreePath: string,
      ): AsyncGenerator<EforgeEvent> {
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
          for await (const event of builderImplement(planFile, { backend, cwd: worktreePath, verbose, abortController })) {
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

        // Emit files changed by implementation (non-critical)
        try {
          const { stdout } = await exec('git', ['diff', '--name-only', `${orchConfig.baseBranch}...HEAD`], { cwd: worktreePath });
          const files = stdout.trim().split('\n').filter(Boolean);
          if (files.length > 0) {
            yield { type: 'build:files_changed', planId, files };
          }
        } catch {
          // Non-critical — skip silently
        }

        // Phase 2 + 3: Review → Evaluate cycle
        yield* runReviewCycle({
          tracing,
          cwd: worktreePath,
          reviewer: {
            role: 'reviewer',
            metadata: { planId },
            run: () => runReview({
              backend,
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
            run: () => builderEvaluate(planFile, { backend, cwd: worktreePath, verbose, abortController }),
          },
        });

        yield { type: 'build:complete', planId };
      };

      // Create validation fixer closure
      const validationFixer: ValidationFixer = async function* (failures, attempt, maxAttempts) {
        const fixerSpan = tracing.createSpan('validation-fixer', { attempt, maxAttempts });
        fixerSpan.setInput({ failures: failures.map((f) => f.command) });
        const fixerTracker = createToolTracker(fixerSpan);
        try {
          for await (const event of runValidationFixer({
            backend,
            cwd,
            failures,
            attempt,
            maxAttempts,
            verbose,
            abortController,
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
      };

      // Create and run orchestrator
      const parallelism = config.build.parallelism;
      const signal = abortController?.signal;
      const orchestrator = new Orchestrator({
        stateDir: cwd,
        repoRoot: cwd,
        planRunner,
        parallelism,
        signal,
        postMergeCommands: config.build.postMergeCommands,
        validateCommands: orchConfig.validate,
        validationFixer,
        maxValidationRetries: config.build.maxValidationRetries,
      });

      for await (const event of orchestrator.execute(orchConfig)) {
        yield event;
        if (event.type === 'validation:complete') {
          if (event.passed) {
            status = 'completed';
            summary = 'Build complete';
          } else {
            status = 'failed';
            summary = 'Post-merge validation failed';
          }
        }
      }

      const shouldCleanup = options.cleanup ?? this.config.build.cleanupPlanFiles;
      if (status === 'completed' && shouldCleanup) {
        yield* cleanupPlanFiles(cwd, planSet);
      }
    } catch (err) {
      status = 'failed';
      summary = (err as Error).message;
    } finally {
      tracing.setOutput({ status, summary });
      yield {
        type: 'phase:end',
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
  status(): EforgeStatus {
    const state = loadState(this.cwd);
    if (!state) {
      return {
        running: false,
        plans: {},
        completedPlans: [],
      };
    }

    const plans: Record<string, EforgeStatus['plans'][string]> = {};
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
    run: () => AsyncGenerator<EforgeEvent>;
  };
  evaluator: {
    role: AgentRole;
    metadata: Record<string, unknown>;
    run: () => AsyncGenerator<EforgeEvent>;
  };
}

/**
 * Run a review → evaluate cycle. The reviewer runs first (non-fatal on error).
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
 * Remove plan files after a successful build and commit the removal.
 */
async function* cleanupPlanFiles(cwd: string, planSet: string): AsyncGenerator<EforgeEvent> {
  yield { type: 'cleanup:start', planSet };

  try {
    const planDir = resolve(cwd, 'plans', planSet);
    await exec('git', ['rm', '-r', '--', planDir], { cwd });

    // Remove empty plans/ directory
    const plansDir = resolve(cwd, 'plans');
    try {
      const remaining = await readdir(plansDir);
      if (remaining.length === 0) {
        await rm(plansDir, { recursive: true });
      }
    } catch { /* may already be gone */ }

    await exec('git', ['commit', '-m', `cleanup(${planSet}): remove plan files after successful build`], { cwd });

    // Clean up state file (gitignored)
    try { await rm(resolve(cwd, '.eforge', 'state.json')); } catch {}
  } catch (err) {
    // Non-fatal — ensure cleanup:complete always pairs with cleanup:start
    yield { type: 'plan:progress', message: `Cleanup failed (non-fatal): ${(err as Error).message}` };
  }

  yield { type: 'cleanup:complete', planSet };
}

/**
 * Deep-merge config overrides onto base config.
 */
function mergeConfig(base: EforgeConfig, overrides: Partial<EforgeConfig>): EforgeConfig {
  return {
    langfuse: overrides.langfuse ? { ...base.langfuse, ...overrides.langfuse } : base.langfuse,
    agents: overrides.agents ? { ...base.agents, ...overrides.agents } : base.agents,
    build: overrides.build ? { ...base.build, ...overrides.build } : base.build,
    plan: overrides.plan ? { ...base.plan, ...overrides.plan } : base.plan,
    plugins: overrides.plugins ? { ...base.plugins, ...overrides.plugins } : base.plugins,
    hooks: overrides.hooks ?? base.hooks,
  };
}

/**
 * Create a tool call tracker for a span.
 * Intercepts tool_use/tool_result/result events and manages Langfuse sub-spans.
 */
function createToolTracker(span: SpanHandle) {
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

/**
 * Load MCP server configs from .mcp.json in the given directory.
 * Returns the mcpServers record, or undefined if no .mcp.json exists.
 */
async function loadMcpServers(cwd: string): Promise<ClaudeSDKBackendOptions['mcpServers'] | undefined> {
  const mcpPath = resolve(cwd, '.mcp.json');
  let content: string;
  try {
    content = await readFile(mcpPath, 'utf-8');
  } catch {
    // No .mcp.json — fine, MCP is optional
    return undefined;
  }

  try {
    const raw = JSON.parse(content);
    if (raw?.mcpServers && typeof raw.mcpServers === 'object' && !Array.isArray(raw.mcpServers)) {
      return raw.mcpServers;
    }
  } catch {
    // Malformed .mcp.json — warn but don't crash
    process.stderr.write(`Warning: failed to parse ${mcpPath}, MCP servers not loaded\n`);
  }
  return undefined;
}

/**
 * Discover Claude Code plugins from ~/.claude/plugins/installed_plugins.json.
 * Loads user-scoped plugins (global) and project-scoped plugins matching the cwd.
 * Applies include/exclude filters and appends manual paths from config.
 */
async function loadPlugins(cwd: string, pluginConfig: PluginConfig): Promise<SdkPluginConfig[] | undefined> {
  if (!pluginConfig.enabled) return undefined;

  const plugins: SdkPluginConfig[] = [];

  // Auto-discover from installed_plugins.json
  const installedPath = resolve(homedir(), '.claude/plugins/installed_plugins.json');
  let installedContent: string | undefined;
  try {
    installedContent = await readFile(installedPath, 'utf-8');
  } catch {
    // No installed plugins file — fine, plugins are optional
  }

  if (installedContent) {
    try {
      const data = JSON.parse(installedContent);
      if (data?.plugins && typeof data.plugins === 'object' && !Array.isArray(data.plugins)) {
        for (const [id, entries] of Object.entries(data.plugins)) {
          // Find first matching entry — plugins may have multiple entries (e.g., user + project scope)
          if (!Array.isArray(entries)) continue;
          for (const entry of entries as Array<Record<string, unknown>>) {
            if (!entry || typeof entry.scope !== 'string' || typeof entry.installPath !== 'string') continue;

            // Include user-scoped (global) and project-scoped plugins matching cwd
            if (entry.scope === 'project') {
              if (typeof entry.projectPath !== 'string') continue;
              const normalizedProject = entry.projectPath.endsWith('/') ? entry.projectPath : entry.projectPath + '/';
              if (cwd !== entry.projectPath && !cwd.startsWith(normalizedProject)) continue;
            } else if (entry.scope !== 'user') {
              continue;
            }

            // Apply include/exclude filters
            if (pluginConfig.include && !pluginConfig.include.includes(id)) break;
            if (pluginConfig.exclude?.includes(id)) break;

            plugins.push({ type: 'local', path: entry.installPath as string });
            break;
          }
        }
      }
    } catch {
      process.stderr.write(`Warning: failed to parse ${installedPath}, plugins not loaded\n`);
    }
  }

  // Append manual paths
  if (pluginConfig.paths) {
    for (const p of pluginConfig.paths) {
      plugins.push({ type: 'local', path: p });
    }
  }

  return plugins.length > 0 ? plugins : undefined;
}

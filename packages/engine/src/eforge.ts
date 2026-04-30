/**
 * EforgeEngine — the sole public API for plan-build-review workflows.
 * All methods return AsyncGenerator<EforgeEvent> (except status() which is synchronous).
 * Engine emits, consumers render — never writes to stdout.
 */

import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, watch as fsWatch, type FSWatcher } from 'node:fs';
import { readFile, readdir, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

import type {
  EforgeEvent,
  EforgeStatus,
  CompileOptions,
  BuildOptions,
  EnqueueOptions,
  PlanFile,
  ClarificationQuestion,
  RecoveryVerdict,
  BuildFailureSummary,
} from './events.js';
import { loadQueue, resolveQueueOrder, getHeadHash, getPrdDiffSummary, enqueuePrd, inferTitle, claimPrd, releasePrd, movePrdToSubdir, moveAndCommitFailedWithSidecar, QueueExecExitCode, QueueSkipReason, propagateSkip as propagateSkipFS, unblockWaiting, commitEnqueuedPrd } from './prd-queue.js';
import { runStalenessAssessor } from './agents/staleness-assessor.js';
import { runRecoveryAnalyst } from './agents/recovery-analyst.js';
import { buildFailureSummary } from './recovery/failure-summary.js';
import { writeRecoverySidecar } from './recovery/sidecar.js';
import { applyRecoveryRetry, applyRecoverySplit, applyRecoveryAbandon, applyRecoveryManual } from './recovery/apply.js';
import { recoveryVerdictSchema } from './schemas.js';
import type { ApplyRecoveryOptions, ApplyRecoveryResult } from './schemas.js';
import { runFormatter } from './agents/formatter.js';
import { runDependencyDetector, type QueueItemSummary, type RunningBuildSummary } from './agents/dependency-detector.js';
import type { EforgeConfig, PluginConfig, ReviewProfileConfig, BuildStageSpec } from './config.js';
import type { AgentHarness } from './harness.js';
import type { ClaudeSDKHarnessOptions } from './harnesses/claude-sdk.js';
import type { SdkPluginConfig, SettingSource } from '@anthropic-ai/claude-agent-sdk';
import { loadConfig, DEFAULT_REVIEW } from './config.js';
import { setPromptDir } from './prompts.js';
import { type AgentRuntimeRegistry, singletonRegistry, buildAgentRuntimeRegistry } from './agent-runtime-registry.js';
import { createTracingContext } from './tracing.js';
import { runValidationFixer } from './agents/validation-fixer.js';
import { runMergeConflictResolver } from './agents/merge-conflict-resolver.js';
import { runPrdValidator } from './agents/prd-validator.js';
import { buildPrdValidatorDiff } from './prd-validator-diff.js';
import { runGapCloser } from './agents/gap-closer.js';
import { Orchestrator, type ValidationFixer, type PrdValidator, type GapCloser } from './orchestrator.js';
import type { MergeResolver } from './worktree-ops.js';
import { computeWorktreeBase, createMergeWorktree } from './worktree-ops.js';
import { deriveNameFromSource, parseOrchestrationConfig, parsePlanFile, validatePlanSet, validatePlanSetName } from './plan.js';
import { loadState, saveState as saveEforgeState } from './state.js';
import { runCompilePipeline, runBuildPipeline, createToolTracker, resolveAgentConfig, type PipelineContext, type BuildStageContext } from './pipeline.js';
import { forgeCommit, retryOnLock } from './git.js';
import { ModelTracker, composeCommitMessage } from './model-tracker.js';
import { cleanupPlanFiles } from './cleanup.js';
import { Semaphore, AsyncEventQueue } from './concurrency.js';
import { withRunId } from './session.js';
import { applyShardedPlanGuard } from './sharded-plan-guard.js';

const exec = promisify(execFile);

export interface EforgeEngineOptions {
  /** Working directory (defaults to process.cwd()) */
  cwd?: string;
  /** Config overrides (deep-merged with loaded config) */
  config?: Partial<EforgeConfig>;
  /** Agent runtime registry. Accepts a registry, a bare AgentHarness (auto-wrapped in singletonRegistry), or omit to build from config. */
  agentRuntimes?: AgentRuntimeRegistry | AgentHarness;
  /** MCP servers to make available to agents (Claude SDK harness only, ignored if agentRuntimes is provided) */
  mcpServers?: ClaudeSDKHarnessOptions['mcpServers'];
  /** Claude Code plugins to load (Claude SDK backend only, ignored if agentRuntimes is provided) */
  plugins?: SdkPluginConfig[];
  /** Which settings sources to load — 'user', 'project', 'local' (Claude SDK backend only) */
  settingSources?: SettingSource[];
  /** Clarification callback for interactive planning */
  onClarification?: (questions: ClarificationQuestion[]) => Promise<Record<string, string>>;
  /** Approval callback for build gates */
  onApproval?: (action: string, details: string) => Promise<boolean>;
}

export interface QueueOptions {
  /** Plan set name override */
  name?: string;
  /** Process all PRDs (including non-pending) */
  all?: boolean;
  /** Bypass approval gates */
  auto?: boolean;
  /** Stream verbose agent output */
  verbose?: boolean;
  /** Disable web monitor */
  noMonitor?: boolean;
  /** AbortController for cancellation */
  abortController?: AbortController;
  /** Enable watch mode — poll for new PRDs after each cycle */
  watch?: boolean;
  /** Poll interval in milliseconds (overrides config) */
  pollIntervalMs?: number;
}

export interface RecoveryOptions {
  /** Stream verbose agent output */
  verbose?: boolean;
  /** AbortController for cancellation */
  abortController?: AbortController;
  /** Working directory override */
  cwd?: string;
}

/**
 * Sleep for the given duration, returning early if the signal fires.
 * Resolves to `true` when aborted, `false` when the timer completes normally.
 */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let timer: ReturnType<typeof setTimeout>;

    const onAbort = () => {
      clearTimeout(timer);
      resolve(true);
    };

    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(false);
    }, ms);

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export { abortableSleep };

export class EforgeEngine {
  private readonly config: EforgeConfig;
  private readonly cwd: string;
  private readonly agentRuntimes: AgentRuntimeRegistry;
  private readonly onClarification?: EforgeEngineOptions['onClarification'];
  private readonly onApproval?: EforgeEngineOptions['onApproval'];
  /** Config warnings collected during loadConfig — emitted as config:warning events. */
  private readonly configWarnings: string[];
  /** Profile data collected during loadConfig — emitted as session:profile event. */
  private readonly configProfile: { name: string | null; source: 'local' | 'project' | 'user-local' | 'missing' | 'none'; scope: 'local' | 'project' | 'user' | null; config: unknown | null };

  private constructor(config: EforgeConfig, options: EforgeEngineOptions = {}, configWarnings: string[] = [], configProfile?: { name: string | null; source: 'local' | 'project' | 'user-local' | 'missing' | 'none'; scope: 'local' | 'project' | 'user' | null; config: unknown | null }) {
    this.config = config;
    this.configWarnings = configWarnings;
    this.configProfile = configProfile ?? { name: null, source: 'none', scope: null, config: null };
    this.cwd = options.cwd ?? process.cwd();
    // agentRuntimes is always resolved to a registry by create() before reaching the constructor
    this.agentRuntimes = options.agentRuntimes as AgentRuntimeRegistry;
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
    const { config: loadedConfig, warnings: configWarnings, profile: configProfile } = await loadConfig(cwd);
    let config = loadedConfig;

    if (options.config) {
      config = mergeConfig(config, options.config);
    }

    // Wire project-level prompt directory override
    setPromptDir(config.agents.promptDir, cwd);

    // Auto-load MCP servers from .mcp.json if not explicitly provided
    if (!options.mcpServers && !options.agentRuntimes) {
      const discovered = await loadMcpServers(cwd);
      if (discovered) {
        options = { ...options, mcpServers: discovered };
      }
    }

    // Auto-load plugins from ~/.claude/plugins/ if not explicitly provided
    if (!options.plugins && !options.agentRuntimes) {
      const discovered = await loadPlugins(cwd, config.plugins);
      if (discovered) {
        options = { ...options, plugins: discovered };
      }
    }

    // Build or wrap the agent runtime registry
    let agentRuntimes: AgentRuntimeRegistry;
    const provided = options.agentRuntimes;
    if (provided !== undefined) {
      // Accept either a full registry or a bare AgentHarness (auto-wrap for test ergonomics)
      agentRuntimes = 'forRole' in (provided as object)
        ? (provided as AgentRuntimeRegistry)
        : singletonRegistry(provided as AgentHarness);
    } else {
      // Build registry from config (handles Pi lazy import, memoization, etc.)
      agentRuntimes = await buildAgentRuntimeRegistry(config, {
        mcpServers: options.mcpServers,
        plugins: options.plugins,
        settingSources: (options.settingSources ?? config.agents.settingSources) as SettingSource[] | undefined,
      });
    }
    options = { ...options, agentRuntimes };

    return new EforgeEngine(config, options, configWarnings, configProfile);
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
    const cwd = options.cwd ?? this.cwd;
    let tracing: ReturnType<typeof createTracingContext> | undefined;

    let status: 'completed' | 'failed' = 'completed';
    let summary = 'Compile complete';

    // Emit profile info before config warnings
    yield { timestamp: new Date().toISOString(), type: 'session:profile', profileName: this.configProfile.name, source: this.configProfile.source, scope: this.configProfile.scope, config: this.configProfile.config };

    // Emit any config warnings collected during engine creation
    for (const warning of this.configWarnings) {
      yield { timestamp: new Date().toISOString(), type: 'config:warning', message: warning, source: 'loadConfig' };
    }

    try {
      const planSetName = options.name ?? deriveNameFromSource(source);
      validatePlanSetName(planSetName);
      tracing = createTracingContext(this.config, runId, 'compile', planSetName);

      yield {
        type: 'phase:start',
        runId,
        planSet: planSetName,
        command: 'compile',
        timestamp: new Date().toISOString(),
      };

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
      // Create merge worktree — all plan artifact commits go here, not repoRoot
      const featureBranch = `eforge/${planSetName}`;
      const { stdout: baseBranchRaw } = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
      const baseBranch = baseBranchRaw.trim();
      const worktreeBase = computeWorktreeBase(cwd, planSetName);
      const mergeWorktreePath = await createMergeWorktree(cwd, worktreeBase, featureBranch, baseBranch);

      // Default pipeline — the planner stage's composePipeline() call will update ctx.pipeline
      // with the actual composition before the planner agent runs.
      const defaultPipeline: import('./schemas.js').PipelineComposition = {
        scope: 'excursion',
        compile: ['planner', 'plan-review-cycle'],
        defaultBuild: ['implement', 'review-cycle'],
        defaultReview: DEFAULT_REVIEW,
        rationale: 'Default pipeline (will be replaced by composer)',
      };

      const ctx: PipelineContext = {
        agentRuntimes: this.agentRuntimes,
        config: this.config,
        pipeline: defaultPipeline,
        tracing,
        cwd: mergeWorktreePath,
        planCommitCwd: mergeWorktreePath,
        baseBranch,
        planSetName,
        sourceContent,
        verbose: options.verbose,
        auto: options.auto,
        abortController: options.abortController,
        onClarification: this.onClarification,
        modelTracker: new ModelTracker(),
        plans: [],
        expeditionModules: [],
        moduleBuildConfigs: new Map(),
      };

      // Run compile pipeline
      yield* runCompilePipeline(ctx);

      // If compile pipeline didn't produce plans and there's no plan-review-cycle
      // in the compile stages, commit artifacts here
      // (runCompilePipeline handles the commit before plan-review-cycle when present)
      if (ctx.plans.length > 0 && !ctx.pipeline.compile.includes('plan-review-cycle')) {
        const planDir = resolve(mergeWorktreePath, this.config.plan.outputDir, planSetName);
        await exec('git', ['add', planDir], { cwd: mergeWorktreePath });
        // Guard: only commit if there are staged changes (prevents "nothing to commit" errors
        // when artifacts were already committed by a previous run/retry).
        const { stdout: staged } = await exec('git', ['diff', '--cached', '--name-only'], { cwd: mergeWorktreePath });
        if (staged.trim().length > 0) {
          await forgeCommit(mergeWorktreePath, composeCommitMessage(`plan(${planSetName}): initial planning artifacts`, ctx.modelTracker));
        }
      }

      // Persist merge worktree path to state for the build phase to pick up.
      // Save a preliminary state with just the merge worktree path — the orchestrator's
      // initializeState() will create the full state with plans during build.
      const preState = loadState(cwd);
      if (preState) {
        preState.mergeWorktreePath = mergeWorktreePath;
        saveEforgeState(cwd, preState);
      } else {
        // No existing state — create a minimal one to carry mergeWorktreePath
        saveEforgeState(cwd, {
          setName: planSetName,
          status: 'running',
          startedAt: new Date().toISOString(),
          baseBranch,
          featureBranch,
          worktreeBase,
          mergeWorktreePath,
          plans: {},
          completedPlans: [],
        });
      }
    } catch (err) {
      status = 'failed';
      summary = (err as Error).message;
    } finally {
      tracing?.setOutput({ status, summary });
      yield {
        type: 'phase:end',
        runId,
        result: { status, summary },
        timestamp: new Date().toISOString(),
      };
      await tracing?.flush();
    }
  }

  /**
   * Enqueue: format a source document and add it to the PRD queue.
   * Runs the formatter agent to normalize content, then writes the
   * PRD file with frontmatter to the queue directory.
   */
  async *enqueue(source: string, options: Partial<EnqueueOptions> = {}): AsyncGenerator<EforgeEvent> {
    const cwd = this.cwd;
    const verbose = options.verbose;
    const abortController = options.abortController;

    // Resolve source content (file path or inline text)
    let sourceContent: string;
    try {
      const sourcePath = resolve(cwd, source);
      const stats = await stat(sourcePath);
      sourceContent = stats.isFile() ? await readFile(sourcePath, 'utf-8') : source;
    } catch {
      sourceContent = source;
    }

    yield { timestamp: new Date().toISOString(), type: 'enqueue:start', source };

    // Run formatter agent to normalize content
    let formattedBody = sourceContent;
    try {
      const formatterConfig = resolveAgentConfig('formatter', this.config);
      const gen = runFormatter({ ...formatterConfig, sourceContent, verbose, abortController, harness: this.agentRuntimes.forRole('formatter') });
      let result = await gen.next();
      while (!result.done) {
        yield result.value;
        result = await gen.next();
      }
      if (result.value?.body) {
        formattedBody = result.value.body;
      }

      // Infer title from formatted content (or from name override)
      const title = options.name ?? inferTitle(formattedBody, !source.includes('\n') ? source : undefined);

      // Run dependency detection (graceful fallback on failure)
      let dependsOn: string[] = [];
      try {
        const queue = await loadQueue(this.config.prdQueue.dir, cwd);
        const queueItems: QueueItemSummary[] = queue
          .map((p) => ({
            id: p.id,
            title: p.frontmatter.title,
            scopeSummary: p.content.slice(0, 500),
          }));

        const state = loadState(cwd);
        const runningBuilds: RunningBuildSummary[] = [];
        if (state && state.status === 'running') {
          runningBuilds.push({
            planSetName: state.setName,
            planTitles: Object.keys(state.plans),
          });
        }

        if (queueItems.length > 0 || runningBuilds.length > 0) {
          const depDetectorConfig = resolveAgentConfig('dependency-detector', this.config);
          const depGen = runDependencyDetector({
            ...depDetectorConfig,
            prdContent: formattedBody,
            queueItems,
            runningBuilds,
            verbose,
            abortController,
            harness: this.agentRuntimes.forRole('dependency-detector'),
          });
          let depResult = await depGen.next();
          while (!depResult.done) {
            yield depResult.value;
            depResult = await depGen.next();
          }
          dependsOn = depResult.value?.dependsOn ?? [];
        }
      } catch {
        // Dependency detection failure should not block enqueue
        dependsOn = [];
      }

      // Write to queue
      const enqueueResult = await enqueuePrd({
        body: formattedBody,
        title,
        queueDir: this.config.prdQueue.dir,
        cwd,
        depends_on: dependsOn,
      });

      // Commit the enqueued PRD
      try {
        await commitEnqueuedPrd(enqueueResult.filePath, enqueueResult.id, title, cwd);
      } catch (err) {
        yield {
          timestamp: new Date().toISOString(),
          type: 'enqueue:commit-failed',
          error: err instanceof Error ? err.message : String(err),
        };
      }

      yield {
        timestamp: new Date().toISOString(),
        type: 'enqueue:complete',
        id: enqueueResult.id,
        filePath: enqueueResult.filePath,
        title,
      };
    } catch (err) {
      yield { timestamp: new Date().toISOString(), type: 'enqueue:failed', error: err instanceof Error ? err.message : String(err) };
      return;
    }
  }

  /**
   * Build: validate plan set, orchestrate parallel execution.
   * Creates Orchestrator with PlanRunner closure for three-phase pipeline.
   */
  async *build(planSet: string, options: Partial<BuildOptions> = {}): AsyncGenerator<EforgeEvent> {
    const runId = randomUUID();
    const cwd = options.cwd ?? this.cwd;
    let tracing: ReturnType<typeof createTracingContext> | undefined;

    let status: 'completed' | 'failed' = 'completed';
    let summary = 'Build complete';

    // Emit profile info before config warnings
    yield { timestamp: new Date().toISOString(), type: 'session:profile', profileName: this.configProfile.name, source: this.configProfile.source, scope: this.configProfile.scope, config: this.configProfile.config };

    // Emit any config warnings collected during engine creation
    for (const warning of this.configWarnings) {
      yield { timestamp: new Date().toISOString(), type: 'config:warning', message: warning, source: 'loadConfig' };
    }

    try {
      validatePlanSetName(planSet);
      tracing = createTracingContext(this.config, runId, 'build', planSet);

      yield {
        type: 'phase:start',
        runId,
        planSet,
        command: 'build',
        timestamp: new Date().toISOString(),
      };

      tracing.setInput({ planSet });
      // Validate plan set
      // Load mergeWorktreePath from state (persisted during compile)
      const existingState = loadState(cwd);
      const mergeWorktreePath = existingState?.mergeWorktreePath;

      // Plan files live in the merge worktree (committed there during compile).
      // Fall back to repoRoot for backwards compatibility with pre-worktree builds.
      const planBaseCwd = mergeWorktreePath ?? cwd;
      const configPath = resolve(planBaseCwd, this.config.plan.outputDir, planSet, 'orchestration.yaml');
      if (!existsSync(configPath)) {
        status = 'failed';
        summary = `orchestration.yaml not found at ${configPath}. The planner may have generated 0 plans without emitting a skip signal.`;
        return;
      }
      const validation = await validatePlanSet(configPath);
      if (!validation.valid) {
        status = 'failed';
        summary = `Plan set validation failed: ${validation.errors.join('; ')}`;
        return;
      }

      // Load orchestration config
      const orchConfig = await parseOrchestrationConfig(configPath);
      // Emit any orchestration config warnings as plan:warning events
      for (const warning of orchConfig.warnings ?? []) {
        yield { timestamp: new Date().toISOString(), type: 'planning:warning', message: warning, source: 'parseOrchestrationConfig' };
      }

      // Pre-load plan files for the runner
      const planDir = resolve(planBaseCwd, this.config.plan.outputDir, planSet);
      const planFileMap = new Map<string, PlanFile>();
      for (const plan of orchConfig.plans) {
        const planFile = await parsePlanFile(resolve(planDir, `${plan.id}.md`));
        // Emit any plan file warnings as plan:warning events
        for (const warning of planFile.warnings ?? []) {
          yield { timestamp: new Date().toISOString(), type: 'planning:warning', planId: plan.id, message: warning, source: 'parsePlanFile' };
        }
        planFileMap.set(plan.id, planFile);
      }

      // Per-plan runner closure — iterates build stages from the composed pipeline
      const config = this.config;
      const agentRuntimes = this.agentRuntimes;
      const verbose = options.verbose;
      const abortController = options.abortController;

      // Use the pipeline persisted in orchestration.yaml during compile
      const buildPipeline = orchConfig.pipeline;

      const planRunner = async function* (
        planId: string,
        worktreePath: string,
      ): AsyncGenerator<EforgeEvent> {
        const planFile = planFileMap.get(planId);
        if (!planFile) {
          yield { timestamp: new Date().toISOString(), type: 'plan:build:failed', planId, error: `Plan file not found: ${planId}` };
          return;
        }

        // Read per-plan build/review from orchestration.yaml plan entry (required fields)
        const planEntry = orchConfig.plans.find((p) => p.id === planId)!;
        let planBuild: BuildStageSpec[] = planEntry.build;
        let planReview: ReviewProfileConfig = planEntry.review;

        // Runtime guard: sharded plans must run review-cycle with the verify perspective.
        // Belt-and-suspenders against planner-prompt omissions. Shards do not self-verify,
        // so the review-cycle's verify perspective is the integration gate.
        const builderShards = planFile.agents?.['builder']?.shards;
        const guardResult = applyShardedPlanGuard(planBuild, planReview, builderShards);
        planBuild = guardResult.planBuild;
        planReview = guardResult.planReview;
        for (const item of guardResult.injected) {
          yield {
            timestamp: new Date().toISOString(),
            type: 'plan:build:progress',
            planId,
            message: `Runtime guard: injected ${item} into sharded plan (shards do not self-verify; review-cycle is the integration gate)`,
          };
        }

        const buildCtx: BuildStageContext = {
          agentRuntimes,
          config,
          pipeline: buildPipeline,
          tracing: tracing!,
          cwd: worktreePath,
          planSetName: planSet,
          sourceContent: '', // Not needed for build stages
          verbose,
          abortController,
          modelTracker: new ModelTracker(),
          plans: Array.from(planFileMap.values()),
          expeditionModules: [],
          moduleBuildConfigs: new Map(),
          planId,
          worktreePath,
          planFile,
          orchConfig,
          planEntry,
          reviewIssues: [],
          build: planBuild,
          review: planReview,
        };

        yield* runBuildPipeline(buildCtx);
      };

      // Create validation fixer closure
      const validationFixer: ValidationFixer = async function* (fixerCwd, failures, attempt, maxAttempts) {
        const fixerSpan = tracing!.createSpan('validation-fixer', { attempt, maxAttempts });
        fixerSpan.setInput({ failures: failures.map((f) => f.command) });
        const fixerTracker = createToolTracker(fixerSpan);
        try {
          const validationFixerConfig = resolveAgentConfig('validation-fixer', config);
          for await (const event of runValidationFixer({
            ...validationFixerConfig,
            cwd: fixerCwd,
            failures,
            attempt,
            maxAttempts,
            verbose,
            abortController,
            harness: agentRuntimes.forRole('validation-fixer'),
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

      // Create merge conflict resolver closure
      const mergeEvents: EforgeEvent[] = [];
      const mergeEventSink = (event: EforgeEvent) => { mergeEvents.push(event); };

      const mergeResolver: MergeResolver = async (resolverCwd, conflict) => {
        const resolverSpan = tracing!.createSpan('merge-conflict-resolver', {
          branch: conflict.branch,
          files: conflict.conflictedFiles,
        });
        const resolverTracker = createToolTracker(resolverSpan);
        let resolved = false;
        try {
          const mergeResolverConfig = resolveAgentConfig('merge-conflict-resolver', config);
          for await (const event of runMergeConflictResolver({
            ...mergeResolverConfig,
            cwd: resolverCwd,
            conflict,
            verbose,
            abortController,
            harness: agentRuntimes.forRole('merge-conflict-resolver'),
          })) {
            resolverTracker.handleEvent(event);
            mergeEventSink(event);
            if (event.type === 'plan:merge:resolve:complete') {
              resolved = event.resolved;
            }
          }
          resolverTracker.cleanup();
          resolverSpan.end();
        } catch (err) {
          resolverTracker.cleanup();
          resolverSpan.error(err as Error);
        }
        return resolved;
      };

      // Create PRD validator closure
      const prdValidator: PrdValidator | undefined = options.prdFilePath ? async function* (validatorCwd) {
        // Read PRD content
        let prdContent: string;
        try {
          prdContent = await readFile(resolve(cwd, options.prdFilePath!), 'utf-8');
        } catch {
          // If PRD file can't be read, skip validation
          return;
        }

        // Build diff: per-file budgeted, no global truncation
        let built: Awaited<ReturnType<typeof buildPrdValidatorDiff>>;
        try {
          built = await buildPrdValidatorDiff({ cwd: validatorCwd, baseRef: orchConfig.baseBranch });
        } catch {
          return;
        }

        if (!built.renderedText.trim()) return;
        const diff = built.renderedText;

        const prdSpan = tracing!.createSpan('prd-validator', {});
        prdSpan.setInput({
          prdLength: prdContent.length,
          diffLength: diff.length,
          totalBytes: built.totalBytes,
          summarizedCount: built.summarizedCount,
          summarizedByPerFileBudget: built.summarizedByPerFileBudget,
          summarizedByGlobalCap: built.summarizedByGlobalCap,
          globalBudgetBytes: built.globalBudgetBytes,
          fileCount: built.files.length,
        });
        const prdTracker = createToolTracker(prdSpan);
        try {
          const prdValidatorConfig = resolveAgentConfig('prd-validator', config);
          for await (const event of runPrdValidator({
            ...prdValidatorConfig,
            cwd: validatorCwd,
            prdContent,
            diff,
            verbose,
            abortController,
            harness: agentRuntimes.forRole('prd-validator'),
          })) {
            prdTracker.handleEvent(event);
            yield event;
          }
          prdTracker.cleanup();
          prdSpan.end();
        } catch (err) {
          prdTracker.cleanup();
          prdSpan.error(err as Error);
          // Propagate the failure so the orchestrator's prdValidate phase can
          // mark the build failed. Swallowing would silently certify a build
          // whose validator never ran (e.g. transient backend 500s).
          throw err;
        }
      } : undefined;

      // Create gap closer closure
      const gapCloser: GapCloser | undefined = options.prdFilePath ? async function* (gapCloserCwd, gaps, completionPercent) {
        // Read PRD content
        let prdContent: string;
        try {
          prdContent = await readFile(resolve(cwd, options.prdFilePath!), 'utf-8');
        } catch {
          return;
        }

        const gapSpan = tracing!.createSpan('gap-closer', {});
        gapSpan.setInput({ gapCount: gaps.length, completionPercent });
        const gapTracker = createToolTracker(gapSpan);
        try {
          const gapCloserConfig = resolveAgentConfig('gap-closer', config);
          for await (const event of runGapCloser({
            ...gapCloserConfig,
            cwd: gapCloserCwd,
            gaps,
            prdContent,
            completionPercent,
            harness: agentRuntimes.forRole('gap-closer'),
            pipelineContext: {
              config,
              pipeline: buildPipeline,
              tracing: tracing!,
              planSetName: planSet,
              orchConfig,
              planFileMap,
            },
            runBuildPipeline,
            verbose,
            abortController,
          })) {
            gapTracker.handleEvent(event);
            yield event;
          }
          gapTracker.cleanup();
          gapSpan.end();
        } catch (err) {
          gapTracker.cleanup();
          gapSpan.error(err as Error);
          throw err;
        }
      } : undefined;

      // Create and run orchestrator
      const signal = abortController?.signal;
      const shouldCleanup = options.cleanup ?? this.config.build.cleanupPlanFiles;
      const orchestrator = new Orchestrator({
        stateDir: cwd,
        repoRoot: cwd,
        planRunner,
        signal,
        postMergeCommands: config.build.postMergeCommands,
        validateCommands: orchConfig.validate,
        postMergeCommandTimeoutMs: config.build.postMergeCommandTimeoutMs,
        validationFixer,
        maxValidationRetries: config.build.maxValidationRetries,
        mergeResolver,
        prdValidator,
        gapCloser,
        mergeWorktreePath,
        shouldCleanup,
        cleanupPlanSet: planSet,
        cleanupOutputDir: this.config.plan.outputDir,
        cleanupPrdFilePath: options.prdFilePath ? relative(cwd, options.prdFilePath) : undefined,
      });

      for await (const event of orchestrator.execute(orchConfig)) {
        // Drain any buffered merge resolution events before yielding the orchestrator event
        while (mergeEvents.length > 0) {
          yield mergeEvents.shift()!;
        }
        yield event;
        if (event.type === 'plan:build:failed') {
          status = 'failed';
          summary = event.error.startsWith('Merge failed')
            ? `Merge failed for ${event.planId}`
            : `Build failed for ${event.planId}`;
        }
        if (event.type === 'validation:complete') {
          if (event.passed) {
            status = 'completed';
            summary = 'Build complete';
          } else {
            status = 'failed';
            summary = 'Post-merge validation failed';
          }
        }
        if (event.type === 'prd_validation:complete') {
          if (!event.passed) {
            status = 'failed';
            summary = `PRD validation failed: ${event.gaps.length} gap(s) found`;
          }
        }
      }

      // Drain any remaining merge resolution events after orchestrator completes
      while (mergeEvents.length > 0) {
        yield mergeEvents.shift()!;
      }

    } catch (err) {
      status = 'failed';
      summary = (err as Error).message;
    } finally {
      // Clean up state file on success. On failure, defer cleanup to the queue
      // parent's finalize handler so recovery can read state.json before removal.
      if (status !== 'failed') {
        try { await rm(resolve(cwd, '.eforge', 'state.json')); } catch {}
      }

      tracing?.setOutput({ status, summary });
      yield {
        type: 'phase:end',
        runId,
        result: { status, summary },
        timestamp: new Date().toISOString(),
      };
      await tracing?.flush();
    }
  }

  /**
   * Process a single PRD: claim, staleness check, compile, build.
   *
   * This method is the subprocess entry point: the scheduler spawns one child
   * process per PRD that calls this directly. It emits events (which the child's
   * monitor recorder writes to SQLite) and returns. The parent scheduler handles
   * lock release and file-location transitions in its child.on('exit') handler
   * based on the child's exit code.
   *
   * When `sessionId` is provided (injected by the parent scheduler via `--session-id`),
   * the child uses it verbatim and does NOT emit `session:start` — the parent already
   * emitted it onto its own event queue so the DB row exists before the child starts.
   * When absent (direct programmatic invocation), generates a new UUID and emits
   * `session:start` as before.
   */
  async *buildSinglePrd(
    prd: import('./prd-queue.js').QueuedPrd,
    options: QueueOptions,
    sessionId?: string,
  ): AsyncGenerator<EforgeEvent> {
    const cwd = this.cwd;
    const verbose = options.verbose;
    const abortController = options.abortController;

    yield {
      timestamp: new Date().toISOString(),
      type: 'queue:prd:start',
      prdId: prd.id,
      title: prd.frontmatter.title,
    };

    // Claim this PRD exclusively — skip if another process already holds it
    const claimed = await claimPrd(prd.id, cwd);
    if (!claimed) {
      yield { timestamp: new Date().toISOString(), type: 'queue:prd:skip', prdId: prd.id, reason: QueueSkipReason.AlreadyClaimed };
      if (sessionId !== undefined) {
        yield { type: 'session:end', sessionId, result: { status: 'skipped', summary: 'PRD already claimed by another process' }, timestamp: new Date().toISOString() } as EforgeEvent;
      }
      yield { timestamp: new Date().toISOString(), type: 'queue:prd:complete', prdId: prd.id, status: 'skipped' };
      return;
    }

    // Staleness check — skip only if PRD was added in the most recent commit
    const headHash = await getHeadHash(cwd);
    if (prd.lastCommitHash && prd.lastCommitHash !== headHash) {
      const diffSummary = await getPrdDiffSummary(prd.lastCommitHash, cwd);

      let stalenessVerdict: 'proceed' | 'revise' | 'obsolete' = 'proceed';
      let revision: string | undefined;

      const stalenessConfig = resolveAgentConfig('staleness-assessor', this.config);
      for await (const event of runStalenessAssessor({
        ...stalenessConfig,
        prdContent: prd.content,
        diffSummary,
        cwd,
        verbose,
        abortController,
        harness: this.agentRuntimes.forRole('staleness-assessor'),
      })) {
        if (event.type === 'queue:prd:stale') {
          stalenessVerdict = event.verdict;
          revision = event.revision;
        }
        yield event;
      }

      if (stalenessVerdict === 'obsolete') {
        yield { timestamp: new Date().toISOString(), type: 'queue:prd:skip', prdId: prd.id, reason: QueueSkipReason.Obsolete };
        if (sessionId !== undefined) {
          yield { type: 'session:end', sessionId, result: { status: 'skipped', summary: 'PRD is obsolete' }, timestamp: new Date().toISOString() } as EforgeEvent;
        }
        yield { timestamp: new Date().toISOString(), type: 'queue:prd:complete', prdId: prd.id, status: 'skipped' };
        return;
      }

      if (stalenessVerdict === 'revise') {
        if (revision) {
          // Auto-apply revision and commit
          await writeFile(prd.filePath, revision, 'utf-8');
          try {
            await retryOnLock(() => exec('git', ['add', '--', prd.filePath], { cwd }), cwd);
            await forgeCommit(cwd, composeCommitMessage(`chore(queue): revise stale PRD ${prd.id}`));
          } catch (err) {
            yield {
              timestamp: new Date().toISOString(),
              type: 'queue:prd:commit-failed',
              prdId: prd.id,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        } else {
          // Skip — needs manual revision
          yield { timestamp: new Date().toISOString(), type: 'queue:prd:skip', prdId: prd.id, reason: QueueSkipReason.NeedsRevision };
          if (sessionId !== undefined) {
            yield { type: 'session:end', sessionId, result: { status: 'skipped', summary: 'PRD needs manual revision' }, timestamp: new Date().toISOString() } as EforgeEvent;
          }
          yield { timestamp: new Date().toISOString(), type: 'queue:prd:complete', prdId: prd.id, status: 'skipped' };
          return;
        }
      }
    }

    // Per-PRD session: each PRD gets its own sessionId for monitor grouping.
    // When sessionId is injected by the parent scheduler, use it verbatim and
    // skip the child-side session:start emission (parent already emitted it).
    const prdSessionId = sessionId ?? randomUUID();
    let prdResult: { status: 'completed' | 'failed' | 'skipped'; summary: string } = {
      status: 'failed',
      summary: 'Session terminated abnormally',
    };

    try {
      if (sessionId === undefined) {
        yield {
          type: 'session:start',
          sessionId: prdSessionId,
          timestamp: new Date().toISOString(),
        } as EforgeEvent;
      }

      // Compile (plan) the PRD
      let compileFailed = false;
      let planSkipped = false;
      let skipReason = '';
      const planSetName = options.name ?? prd.id;

      for await (const event of withRunId(this.compile(prd.filePath, {
        name: planSetName,
        auto: options.auto,
        verbose,
        cwd,
        abortController,
      }))) {
        yield { ...event, sessionId: prdSessionId } as EforgeEvent;
        if (event.type === 'phase:end' && event.result.status === 'failed') {
          compileFailed = true;
        }
        if (event.type === 'planning:skip') {
          planSkipped = true;
          skipReason = event.reason;
        }
      }

      if (compileFailed) {
        prdResult = { status: 'failed', summary: 'Compile failed' };
        return;
      }

      if (planSkipped) {
        prdResult = { status: 'skipped', summary: skipReason };
        return;
      }

      // Build the plan — PRD cleanup flows through build()
      let buildFailed = false;
      for await (const event of withRunId(this.build(planSetName, {
        auto: options.auto,
        verbose,
        cwd,
        abortController,
        prdFilePath: prd.filePath,
      }))) {
        yield { ...event, sessionId: prdSessionId } as EforgeEvent;
        if (event.type === 'phase:end' && event.result.status === 'failed') {
          buildFailed = true;
        }
      }

      if (buildFailed) {
        prdResult = { status: 'failed', summary: 'Build failed' };
      } else {
        prdResult = { status: 'completed', summary: 'Build complete' };
      }
    } catch (err) {
      prdResult = { status: 'failed', summary: (err as Error).message };
    } finally {
      // Lock release and PRD file-location transitions are the parent
      // scheduler's responsibility (via child.on('exit')). This child only
      // emits terminal events and returns.
      yield {
        type: 'session:end',
        sessionId: prdSessionId,
        result: prdResult,
        timestamp: new Date().toISOString(),
      } as EforgeEvent;

      yield { timestamp: new Date().toISOString(), type: 'queue:prd:complete', prdId: prd.id, status: prdResult.status };
    }
  }

  /**
   * Spawn a child process to build a single PRD, and do all file/lock
   * cleanup in the exit handler.
   *
   * This is the sole cleanup path for normal and crash scenarios alike: when
   * the child exits (cleanly, via signal, or via spawn error), the parent
   * decides what to do with the PRD file and the lock based on the exit
   * code contract defined by `QueueExecExitCode`. This replaces the
   * finally-block cleanup in `buildSinglePrd` so a SIGTERM mid-build cannot
   * leave stale state behind — the parent's exit handler runs regardless.
   */
  private spawnPrdChild(
    prd: import('./prd-queue.js').QueuedPrd,
    options: QueueOptions,
    prdSessionId: string,
  ): Promise<'completed' | 'failed' | 'skipped'> {
    const cwd = this.cwd;
    const agentRuntimes = this.agentRuntimes; // captured for inline recovery
    const config = this.config;               // captured for inline recovery
    const prdId = prd.id;
    const filePath = prd.filePath;
    const abortController = options.abortController;

    return new Promise((resolvePromise) => {
      const args = ['queue', 'exec', prdId];
      if (options.auto) args.push('--auto');
      if (options.verbose) args.push('--verbose');
      args.push('--no-monitor');
      args.push('--session-id', prdSessionId);

      // Use the current Node binary + the CLI entrypoint so the child is
      // guaranteed to be the same build as the parent. Spawning bare `eforge`
      // from PATH would risk parent/child version skew (the exit code contract
      // could be interpreted differently on each side).
      //
      // Prefer EFORGE_CLI_PATH — the CLI sets this when forking the daemon so
      // the in-process watcher can still locate the CLI even though its own
      // argv[1] points at the monitor's server-main. Fall back to argv[1] for
      // the direct-CLI path (e.g. `eforge run --queue --watch`).
      const cliEntrypoint = process.env.EFORGE_CLI_PATH ?? process.argv[1];
      const child = cliEntrypoint
        ? spawn(process.execPath, [cliEntrypoint, ...args], { cwd, stdio: 'ignore' })
        : spawn('eforge', args, { cwd, stdio: 'ignore' });

      // Aborting the scheduler does not kill this child — children are
      // always left to drain. When the user wants to cancel a specific
      // build, the daemon's cancelWorker path sends SIGTERM directly by
      // PID; on terminal Ctrl+C, the signal reaches children via the
      // shared process group without needing a listener here.

      // `exit` and `error` can both fire (e.g. ENOENT during spawn emits
      // `error` plus a synthetic `exit` with code=null). Guard so cleanup
      // runs exactly once.
      let finalized = false;

      const finalize = async (exitCode: number | null, signal: NodeJS.Signals | null): Promise<void> => {
        if (finalized) return;
        finalized = true;

        const isSignalKill = signal !== null;
        const wasAborted = abortController?.signal.aborted === true;
        const isAlreadyClaimed = exitCode === QueueExecExitCode.SkippedAlreadyClaimed;
        const needsRevision = exitCode === QueueExecExitCode.SkippedNeedsRevision;

        let status: 'completed' | 'failed' | 'skipped';
        let moveTo: 'failed' | 'skipped' | null;
        const shouldRelease = !isAlreadyClaimed;

        if (isSignalKill && wasAborted) {
          // User-requested cancel (parent sent SIGTERM in response to abort).
          // Leave the PRD in queue/ so a subsequent run can pick it up;
          // don't mark it failed — that would trip the "don't retry failed
          // builds" behavior.
          status = 'skipped';
          moveTo = null;
        } else if (isSignalKill) {
          // Unsolicited signal (OOM kill, SIGKILL from outside). Treat as failure.
          status = 'failed';
          moveTo = 'failed';
        } else if (exitCode === QueueExecExitCode.Completed) {
          status = 'completed';
          moveTo = null;
        } else if (exitCode === QueueExecExitCode.Skipped) {
          status = 'skipped';
          moveTo = 'skipped';
        } else if (isAlreadyClaimed || needsRevision) {
          status = 'skipped';
          moveTo = null;
        } else {
          status = 'failed';
          moveTo = 'failed';
        }

        try {
          if (shouldRelease) {
            try { await releasePrd(prdId, cwd); } catch { /* best-effort */ }
          }
          if (moveTo === 'failed') {
            // Run recovery inline against the still-present state.json, then
            // commit the PRD move + both sidecar files atomically.
            const state = loadState(cwd);
            const setName = state?.setName ?? prdId;
            const dbPath = resolve(cwd, '.eforge', 'monitor.db');

            // Build failure summary (tolerates missing state.json)
            let summary: BuildFailureSummary;
            try {
              summary = await buildFailureSummary({ setName, prdId, cwd, dbPath });
            } catch {
              summary = {
                prdId,
                setName,
                featureBranch: `eforge/${setName}`,
                baseBranch: '',
                plans: [],
                failingPlan: { planId: 'unknown' },
                landedCommits: [],
                diffStat: '',
                modelsUsed: [],
                failedAt: new Date().toISOString(),
                partial: true,
              };
            }

            // Read PRD content (best-effort — child just exited, file should exist)
            let prdContent = '';
            try { prdContent = await readFile(filePath, 'utf-8'); } catch { /* ignore */ }

            // Run recovery analyst with 90s timeout
            let verdict: RecoveryVerdict;
            const recoveryModelTracker = new ModelTracker();
            const recoveryAbort = new AbortController();
            const recoveryTimer = setTimeout(() => recoveryAbort.abort(), 90_000);
            try {
              let verdictResult: RecoveryVerdict | null = null;
              const harness = agentRuntimes.forRole('recovery-analyst');
              const agentConfig =
                config.agentRuntimes && Object.keys(config.agentRuntimes).length > 0
                  ? resolveAgentConfig('recovery-analyst', config)
                  : {};

              try {
                for await (const event of runRecoveryAnalyst({
                  ...agentConfig,
                  harness,
                  prdContent,
                  summary,
                  prdId,
                  cwd,
                  abortController: recoveryAbort,
                })) {
                  if (event.type === 'recovery:complete') {
                    verdictResult = event.verdict;
                  }
                  if (event.type === 'agent:start' && 'model' in event && typeof event.model === 'string') {
                    recoveryModelTracker.record(event.model);
                  }
                }
              } catch (agentErr) {
                // Agent failed or timed out — fall through to manual verdict
                verdict = {
                  verdict: 'manual',
                  confidence: 'low',
                  rationale: 'Recovery analyst failed or timed out.',
                  completedWork: [],
                  remainingWork: [],
                  risks: [],
                  partial: true,
                  recoveryError: agentErr instanceof Error ? agentErr.message : String(agentErr),
                };
              }

              if (!verdict!) {
                verdict = verdictResult ?? {
                  verdict: 'manual',
                  confidence: 'low',
                  rationale: 'Recovery analyst output could not be parsed.',
                  completedWork: [],
                  remainingWork: [],
                  risks: [],
                  partial: summary.partial === true,
                  recoveryError: 'Failed to parse recovery analyst output',
                };
              }
            } finally {
              clearTimeout(recoveryTimer);
            }

            // Atomic commit: git mv + both sidecar files in one forgeCommit
            try {
              await moveAndCommitFailedWithSidecar(filePath, summary, verdict!, recoveryModelTracker, cwd);
            } catch {
              // Fallback: plain move without sidecars
              try { await movePrdToSubdir(filePath, 'failed', cwd); } catch { /* best-effort */ }
            }

            // Best-effort cleanup state.json after the failure commit lands
            try { await rm(resolve(cwd, '.eforge', 'state.json')); } catch { /* ignore ENOENT */ }

          } else if (moveTo) {
            try {
              await movePrdToSubdir(filePath, moveTo, cwd);
            } catch {
              // File may already be moved, deleted (completed), or missing.
              // Best-effort — the startup reconciler is the backstop.
            }
          }
        } finally {
          resolvePromise(status);
        }
      };

      child.on('exit', (code, signal) => {
        void finalize(code, signal);
      });
      child.on('error', () => {
        void finalize(QueueExecExitCode.Failed, null);
      });
    });
  }

  /**
   * Queue: process PRDs from a queue directory with greedy semaphore-limited scheduling.
   * For each PRD: staleness check → compile → build.
   * Updates frontmatter status as PRDs are processed.
   * At parallelism=1 (default), behavior is identical to sequential execution.
   */
  async *runQueue(options: QueueOptions = {}): AsyncGenerator<EforgeEvent> {
    const cwd = this.cwd;
    const queueDir = this.config.prdQueue.dir;
    const abortController = options.abortController;

    // Load and order queue
    const allPrds = await loadQueue(queueDir, cwd);
    const allOrdered = resolveQueueOrder(allPrds);

    // If a name is provided, filter to only that PRD (used by foreground build)
    let orderedPrds = options.name
      ? allOrdered.filter((p) => p.id === options.name)
      : [...allOrdered];

    yield {
      timestamp: new Date().toISOString(),
      type: 'queue:start',
      prdCount: orderedPrds.length,
      dir: queueDir,
    };

    // Per-PRD state tracking for the greedy scheduler
    type PrdRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'blocked';
    interface PrdRunState {
      status: PrdRunStatus;
      dependsOn: string[];
    }

    const prdState = new Map<string, PrdRunState>();
    for (const prd of orderedPrds) {
      const deps = (prd.frontmatter.depends_on ?? []).filter((dep) =>
        orderedPrds.some((p) => p.id === dep),
      );
      prdState.set(prd.id, { status: 'pending', dependsOn: deps });
    }

    const isReady = (prdId: string): boolean => {
      const state = prdState.get(prdId)!;
      if (state.status !== 'pending') return false;
      return state.dependsOn.every((dep) => {
        const depState = prdState.get(dep);
        return depState && (depState.status === 'completed' || depState.status === 'skipped');
      });
    };

    const propagateBlocked = (failedId: string): void => {
      // Mark all transitive dependents as blocked
      const queue = [failedId];
      while (queue.length > 0) {
        const current = queue.shift()!;
        for (const [id, state] of prdState) {
          if (state.status === 'pending' && state.dependsOn.includes(current)) {
            state.status = 'blocked';
            queue.push(id);
          }
        }
      }
    };

    const parallelism = this.config.maxConcurrentBuilds;
    const semaphore = new Semaphore(parallelism);
    const eventQueue = new AsyncEventQueue<EforgeEvent>();

    let processed = 0;
    let skipped = 0;

    /**
     * Re-scan the queue directory, discover new PRDs not yet in prdState,
     * and emit queue:prd:discovered for each. Idempotent - safe to call repeatedly.
     */
    const discoverNewPrds = async (): Promise<void> => {
      let freshPrds: Awaited<ReturnType<typeof loadQueue>>;
      try {
        freshPrds = await loadQueue(queueDir, cwd);
      } catch {
        // Filesystem or parse error during re-scan — skip discovery this cycle
        // rather than crashing the queue while other PRDs may be running.
        return;
      }
      const freshOrdered = resolveQueueOrder(freshPrds);
      for (const prd of freshOrdered) {
        if (!prdState.has(prd.id)) {
          const deps = (prd.frontmatter.depends_on ?? []).filter((dep) =>
            prdState.has(dep) || freshOrdered.some((p) => p.id === dep),
          );
          prdState.set(prd.id, { status: 'pending', dependsOn: deps });
          orderedPrds.push(prd);
          eventQueue.push({
            timestamp: new Date().toISOString(),
            type: 'queue:prd:discovered',
            prdId: prd.id,
            title: prd.frontmatter.title ?? prd.id,
          } as EforgeEvent);
        }
      }
    };

    const startReadyPrds = (): void => {
      for (const prd of orderedPrds) {
        if (abortController?.signal.aborted) break;
        if (!isReady(prd.id)) continue;

        const state = prdState.get(prd.id)!;
        state.status = 'running';

        // Parent owns the sessionId: generate it here and emit session:start
        // immediately so the DB row exists before the child subprocess starts.
        // The child receives the id via --session-id and skips its own
        // session:start emission to avoid double-creating the row.
        const prdSessionId = randomUUID();
        eventQueue.push({
          type: 'session:start',
          sessionId: prdSessionId,
          timestamp: new Date().toISOString(),
        } as EforgeEvent);
        eventQueue.push({
          type: 'session:profile',
          sessionId: prdSessionId,
          profileName: this.configProfile.name,
          source: this.configProfile.source,
          scope: this.configProfile.scope,
          config: this.configProfile.config,
          timestamp: new Date().toISOString(),
        } as EforgeEvent);

        eventQueue.addProducer();

        // Launch asynchronously — semaphore gates actual execution.
        // Each PRD runs as its own OS process via spawnPrdChild, which
        // owns lock release and PRD file transitions in its exit handler.
        void (async () => {
          let acquired = false;
          let status: 'completed' | 'failed' | 'skipped' = 'failed';
          try {
            await semaphore.acquire();
            acquired = true;

            status = await this.spawnPrdChild(prd, options, prdSessionId);

            eventQueue.push({
              timestamp: new Date().toISOString(),
              type: 'queue:prd:complete',
              prdId: prd.id,
              status,
            } as EforgeEvent);
          } catch {
            status = 'failed';
            eventQueue.push({
              timestamp: new Date().toISOString(),
              type: 'queue:prd:complete',
              prdId: prd.id,
              status: 'failed',
            } as EforgeEvent);
          } finally {
            if (acquired) semaphore.release();

            const finalState = prdState.get(prd.id)!;
            if (finalState.status === 'running') {
              finalState.status = status;
            }

            if (finalState.status === 'failed') {
              propagateBlocked(prd.id);
            }

            eventQueue.removeProducer();
          }
        })();
      }

    };

    // Seed the scheduler
    startReadyPrds();

    // If nothing was launched (empty queue or all blocked), add/remove a producer to close the queue
    const hasAnyRunning = [...prdState.values()].some((s) => s.status === 'running');
    if (!hasAnyRunning) {
      eventQueue.addProducer();
      eventQueue.removeProducer();
    }

    // Consume multiplexed events
    for await (const event of eventQueue) {
      yield event;

      // On PRD completion, update counters and try to launch newly-ready PRDs.
      // State transitions are handled by the producer's finally block (which runs
      // before removeProducer), so we only need to update counters here.
      if (event.type === 'queue:prd:complete') {
        const completionStatus = (event as { status: string }).status;
        const completedPrdId = (event as { prdId: string }).prdId;
        if (completionStatus === 'skipped') {
          skipped++;
        } else {
          processed++;
        }

        // Keep the queue open during discovery so pushed events are not dropped
        eventQueue.addProducer();

        // --- eforge:region plan-05-piggyback-and-queue-scheduling ---
        // Transition filesystem state for waiting PRDs before discovering new ones.
        // This ensures discoverNewPrds() finds any newly unblocked PRDs.
        if (completionStatus === 'completed') {
          try {
            await unblockWaiting(queueDir, cwd, completedPrdId);
          } catch {
            // Non-fatal: filesystem unblock failure doesn't stop the scheduler
          }
        } else if (completionStatus === 'failed') {
          try {
            await propagateSkipFS(queueDir, cwd, completedPrdId, 'failed');
          } catch {
            // Non-fatal: filesystem skip propagation failure doesn't stop the scheduler
          }
        } else if (completionStatus === 'skipped') {
          try {
            await propagateSkipFS(queueDir, cwd, completedPrdId, 'cancelled');
          } catch {
            // Non-fatal
          }
        }
        // --- eforge:endregion plan-05-piggyback-and-queue-scheduling ---

        // Discover any new PRDs enqueued mid-cycle, then launch newly-ready PRDs
        await discoverNewPrds();
        startReadyPrds();
        eventQueue.removeProducer();
      }
    }

    // Count blocked PRDs as skipped
    for (const [, state] of prdState) {
      if (state.status === 'blocked') {
        skipped++;
      }
    }

    yield {
      timestamp: new Date().toISOString(),
      type: 'queue:complete',
      processed,
      skipped,
    };
  }

  /**
   * Watch queue: long-lived fs.watch-based watcher that discovers new PRDs
   * via filesystem events. Uses a 500ms debounce to coalesce rapid events.
   * Stays alive until abort signal fires or SIGTERM.
   */
  async *watchQueue(options: QueueOptions = {}): AsyncGenerator<EforgeEvent> {
    const cwd = this.cwd;
    const queueDir = this.config.prdQueue.dir;
    const absQueueDir = resolve(cwd, queueDir);
    // If no abortController provided, create an internal one wired to process
    // signals so the watcher can be gracefully shut down on SIGTERM/SIGINT
    const abortController = options.abortController ?? new AbortController();
    if (!options.abortController) {
      const signalHandler = (): void => { abortController.abort(); };
      process.once('SIGTERM', signalHandler);
      process.once('SIGINT', signalHandler);
    }

    // Ensure queue directory exists before watching
    await mkdir(absQueueDir, { recursive: true });

    // Load and order initial queue
    const allPrds = await loadQueue(queueDir, cwd);
    const allOrdered = resolveQueueOrder(allPrds);

    let orderedPrds = options.name
      ? allOrdered.filter((p) => p.id === options.name)
      : [...allOrdered];

    yield {
      timestamp: new Date().toISOString(),
      type: 'queue:start',
      prdCount: orderedPrds.length,
      dir: queueDir,
    };

    // Per-PRD state tracking for the greedy scheduler
    type PrdRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'blocked';
    interface PrdRunState {
      status: PrdRunStatus;
      dependsOn: string[];
    }

    const prdState = new Map<string, PrdRunState>();
    for (const prd of orderedPrds) {
      const deps = (prd.frontmatter.depends_on ?? []).filter((dep) =>
        orderedPrds.some((p) => p.id === dep),
      );
      prdState.set(prd.id, { status: 'pending', dependsOn: deps });
    }

    const isReady = (prdId: string): boolean => {
      const state = prdState.get(prdId)!;
      if (state.status !== 'pending') return false;
      return state.dependsOn.every((dep) => {
        const depState = prdState.get(dep);
        return depState && (depState.status === 'completed' || depState.status === 'skipped');
      });
    };

    const propagateBlocked = (failedId: string): void => {
      const queue = [failedId];
      while (queue.length > 0) {
        const current = queue.shift()!;
        for (const [id, state] of prdState) {
          if (state.status === 'pending' && state.dependsOn.includes(current)) {
            state.status = 'blocked';
            queue.push(id);
          }
        }
      }
    };

    const parallelism = this.config.maxConcurrentBuilds;
    const semaphore = new Semaphore(parallelism);
    const eventQueue = new AsyncEventQueue<EforgeEvent>();

    let processed = 0;
    let skipped = 0;

    /**
     * Re-scan the queue directory, discover new PRDs not yet in prdState,
     * and emit queue:prd:discovered for each. Also resets re-queued PRDs
     * that were previously failed or blocked back to pending.
     */
    const discoverNewPrds = async (): Promise<void> => {
      let freshPrds: Awaited<ReturnType<typeof loadQueue>>;
      try {
        freshPrds = await loadQueue(queueDir, cwd);
      } catch {
        return;
      }
      const freshOrdered = resolveQueueOrder(freshPrds);
      for (const prd of freshOrdered) {
        if (!prdState.has(prd.id)) {
          const deps = (prd.frontmatter.depends_on ?? []).filter((dep) =>
            prdState.has(dep) || freshOrdered.some((p) => p.id === dep),
          );
          prdState.set(prd.id, { status: 'pending', dependsOn: deps });
          orderedPrds.push(prd);
          eventQueue.push({
            timestamp: new Date().toISOString(),
            type: 'queue:prd:discovered',
            prdId: prd.id,
            title: prd.frontmatter.title ?? prd.id,
          } as EforgeEvent);
        } else {
          const existing = prdState.get(prd.id)!;
          if (existing.status === 'failed' || existing.status === 'blocked') {
            // Re-queued PRD: reset state to pending
            const deps = (prd.frontmatter.depends_on ?? []).filter((dep) =>
              prdState.has(dep) || freshOrdered.some((p) => p.id === dep),
            );
            existing.status = 'pending';
            existing.dependsOn = deps;
            // Replace stale entry in orderedPrds with fresh PRD object
            const idx = orderedPrds.findIndex((p) => p.id === prd.id);
            if (idx !== -1) {
              orderedPrds[idx] = prd;
            } else {
              orderedPrds.push(prd);
            }
            eventQueue.push({
              timestamp: new Date().toISOString(),
              type: 'queue:prd:discovered',
              prdId: prd.id,
              title: prd.frontmatter.title ?? prd.id,
            } as EforgeEvent);
          }
        }
      }
    };

    const startReadyPrds = (): void => {
      for (const prd of orderedPrds) {
        if (abortController?.signal.aborted) break;
        if (!isReady(prd.id)) continue;

        const state = prdState.get(prd.id)!;
        state.status = 'running';

        // Parent owns the sessionId: generate it here and emit session:start
        // immediately so the DB row exists before the child subprocess starts.
        // The child receives the id via --session-id and skips its own
        // session:start emission to avoid double-creating the row.
        const prdSessionId = randomUUID();
        eventQueue.push({
          type: 'session:start',
          sessionId: prdSessionId,
          timestamp: new Date().toISOString(),
        } as EforgeEvent);
        eventQueue.push({
          type: 'session:profile',
          sessionId: prdSessionId,
          profileName: this.configProfile.name,
          source: this.configProfile.source,
          scope: this.configProfile.scope,
          config: this.configProfile.config,
          timestamp: new Date().toISOString(),
        } as EforgeEvent);

        eventQueue.addProducer();

        void (async () => {
          let acquired = false;
          let status: 'completed' | 'failed' | 'skipped' = 'failed';
          try {
            await semaphore.acquire();
            acquired = true;

            status = await this.spawnPrdChild(prd, options, prdSessionId);

            eventQueue.push({
              timestamp: new Date().toISOString(),
              type: 'queue:prd:complete',
              prdId: prd.id,
              status,
            } as EforgeEvent);
          } catch {
            status = 'failed';
            eventQueue.push({
              timestamp: new Date().toISOString(),
              type: 'queue:prd:complete',
              prdId: prd.id,
              status: 'failed',
            } as EforgeEvent);
          } finally {
            if (acquired) semaphore.release();

            const finalState = prdState.get(prd.id)!;
            if (finalState.status === 'running') {
              finalState.status = status;
            }

            if (finalState.status === 'failed') {
              propagateBlocked(prd.id);
            }

            eventQueue.removeProducer();
          }
        })();
      }
    };

    // Register fs.watch as a producer — keeps the consumer loop alive
    eventQueue.addProducer();

    // Set up fs.watch with 500ms debounce
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let watcher: FSWatcher | null = null;

    // Circuit breaker: track consecutive fs.watch failures for recovery
    const failureTimestamps: number[] = [];
    const MAX_CONSECUTIVE_FAILURES = 3;
    const FAILURE_WINDOW_MS = 10_000;

    const onFsChange = async (): Promise<void> => {
      await discoverNewPrds();
      startReadyPrds();
    };

    /**
     * Set up (or re-establish) the fs.watch watcher on the queue directory.
     * Called during initial setup and during recovery after directory deletion.
     */
    const setupWatcher = (): void => {
      watcher = fsWatch(absQueueDir, { persistent: true }, () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          debounceTimer = null;
          void onFsChange();
        }, 500);
      });

      // Handle watcher errors (e.g. directory removed, permission change)
      // with recovery: recreate directory, re-establish watcher, re-scan.
      watcher.on('error', () => {
        const now = Date.now();
        failureTimestamps.push(now);

        // Prune failures outside the window
        while (failureTimestamps.length > 0 && failureTimestamps[0] <= now - FAILURE_WINDOW_MS) {
          failureTimestamps.shift();
        }

        // Circuit breaker: too many consecutive failures within the window
        if (failureTimestamps.length >= MAX_CONSECUTIVE_FAILURES) {
          onAbort();
          return;
        }

        // Recovery: close broken watcher, recreate directory, re-establish watcher
        if (debounceTimer) {
          clearTimeout(debounceTimer);
          debounceTimer = null;
        }
        if (watcher) {
          watcher.close();
          watcher = null;
        }

        void (async () => {
          try {
            await mkdir(absQueueDir, { recursive: true });
            setupWatcher();
            await discoverNewPrds();
            startReadyPrds();
          } catch {
            // Recovery itself failed — abort
            onAbort();
          }
        })();
      });
    };

    setupWatcher();

    // Clean shutdown on abort: close watcher, let in-flight builds drain
    const onAbort = (): void => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      if (watcher) {
        watcher.close();
        watcher = null;
      }
      // Remove the fs.watch producer — consumer will drain remaining events
      // and terminate once all build producers also finish
      eventQueue.removeProducer();
    };

    if (abortController.signal.aborted) {
      onAbort();
    } else {
      abortController.signal.addEventListener('abort', onAbort, { once: true });
    }

    // Initial scan + launch ready PRDs
    startReadyPrds();

    // Consume multiplexed events
    for await (const event of eventQueue) {
      yield event;

      if (event.type === 'queue:prd:complete') {
        const completionStatus = event.status;
        const completedPrdId = event.prdId;
        if (completionStatus === 'skipped') {
          skipped++;
        } else {
          processed++;
        }

        // --- eforge:region plan-05-piggyback-and-queue-scheduling ---
        // Transition filesystem state for waiting PRDs before discovering new ones.
        if (completionStatus === 'completed') {
          try {
            await unblockWaiting(queueDir, cwd, completedPrdId);
          } catch {
            // Non-fatal
          }
        } else if (completionStatus === 'failed') {
          try {
            await propagateSkipFS(queueDir, cwd, completedPrdId, 'failed');
          } catch {
            // Non-fatal
          }
        } else if (completionStatus === 'skipped') {
          try {
            await propagateSkipFS(queueDir, cwd, completedPrdId, 'cancelled');
          } catch {
            // Non-fatal
          }
        }
        // --- eforge:endregion plan-05-piggyback-and-queue-scheduling ---

        // Discover any new PRDs and launch newly-ready PRDs
        await discoverNewPrds();
        startReadyPrds();
      }
    }

    // Count blocked PRDs as skipped
    for (const [, state] of prdState) {
      if (state.status === 'blocked') {
        skipped++;
      }
    }

    yield {
      timestamp: new Date().toISOString(),
      type: 'queue:complete',
      processed,
      skipped,
    };
  }

  /**
   * Recover: analyse a failed build, emit a typed verdict, and write sidecar files.
   *
   * Orchestrates: PRD file read → buildFailureSummary → recovery-analyst agent →
   * writeRecoverySidecar. On any error (PRD missing, agent timeout, git failure),
   * still writes a sidecar with a degraded manual verdict so the caller always
   * receives an artifact. Never throws.
   *
   * When state.json is missing, synthesizes a partial summary from monitor.db events
   * and git history. Passes `partial: true` through to the verdict so the recovery
   * analyst and sidecar both indicate degraded context.
   */
  async *recover(setName: string, prdId: string, options: RecoveryOptions = {}): AsyncGenerator<EforgeEvent> {
    const cwd = options.cwd ?? this.cwd;
    const verbose = options.verbose;
    const abortController = options.abortController;

    const failedDir = resolve(cwd, this.config.prdQueue.dir, 'failed');
    const prdPath = join(failedDir, `${prdId}.md`);
    const dbPath = resolve(cwd, '.eforge', 'monitor.db');

    // Always emit recovery:start first
    yield { timestamp: new Date().toISOString(), type: 'recovery:start', prdId, setName };
    yield { timestamp: new Date().toISOString(), type: 'session:profile', profileName: this.configProfile.name, source: this.configProfile.source, scope: this.configProfile.scope, config: this.configProfile.config };

    try {
      // Try to read PRD file
      let prdContent: string | undefined;
      let prdMissingError: string | undefined;
      try {
        prdContent = await readFile(prdPath, 'utf-8');
      } catch {
        prdMissingError = `PRD file not found: ${prdPath}`;
      }

      if (prdMissingError !== undefined || prdContent === undefined) {
        // PRD missing — write degraded sidecar and return
        const summary: BuildFailureSummary = {
          prdId, setName,
          featureBranch: `eforge/${setName}`,
          baseBranch: 'main',
          plans: [],
          failingPlan: { planId: 'unknown' },
          landedCommits: [],
          diffStat: '',
          modelsUsed: [],
          failedAt: new Date().toISOString(),
          partial: true,
        };
        const verdict: RecoveryVerdict = {
          verdict: 'manual',
          confidence: 'low',
          rationale: 'Recovery failed: PRD file not found.',
          completedWork: [],
          remainingWork: [],
          risks: [],
          partial: true,
          recoveryError: prdMissingError ?? 'PRD file not found',
        };
        const { mdPath, jsonPath } = await writeRecoverySidecar({ failedPrdDir: failedDir, prdId, summary, verdict });
        yield {
          timestamp: new Date().toISOString(),
          type: 'recovery:complete',
          prdId,
          verdict,
          sidecarMdPath: mdPath,
          sidecarJsonPath: jsonPath,
        };
        return;
      }

      // Get failure summary (tolerates missing state.json via partial synthesis)
      let summary: BuildFailureSummary;
      try {
        summary = await buildFailureSummary({ setName, prdId, cwd, dbPath });
      } catch {
        summary = {
          prdId, setName,
          featureBranch: `eforge/${setName}`,
          baseBranch: 'main',
          plans: [],
          failingPlan: { planId: 'unknown' },
          landedCommits: [],
          diffStat: '',
          modelsUsed: [],
          failedAt: new Date().toISOString(),
          partial: true,
        };
      }

      // Get recovery-analyst harness and config
      const harness = this.agentRuntimes.forRole('recovery-analyst');
      const agentConfig =
        this.config.agentRuntimes && Object.keys(this.config.agentRuntimes).length > 0
          ? resolveAgentConfig('recovery-analyst', this.config)
          : {};

      // Run recovery analyst — collect verdict or error
      let verdictResult: RecoveryVerdict | null = null;
      let parseError: string | undefined;
      let agentError: string | undefined;

      try {
        for await (const event of runRecoveryAnalyst({
          ...agentConfig,
          harness,
          prdContent,
          summary,
          prdId,
          cwd,
          verbose,
          abortController,
        })) {
          if (event.type === 'recovery:complete') {
            // Collect the verdict; we will re-emit recovery:complete with sidecar paths below
            verdictResult = event.verdict;
          } else if (event.type === 'recovery:error') {
            parseError = event.error;
            yield event;
          } else {
            yield event;
          }
        }
      } catch (err) {
        agentError = err instanceof Error ? err.message : String(err);
      }

      // Determine final verdict — fallback to manual on parse or agent failure
      const verdict: RecoveryVerdict = verdictResult ?? {
        verdict: 'manual',
        confidence: 'low',
        rationale: `Recovery analyst failed or output could not be parsed. ${agentError ?? parseError ?? 'Unknown error.'}`,
        completedWork: [],
        remainingWork: [],
        risks: [],
        partial: summary.partial === true || agentError !== undefined,
        recoveryError: agentError ?? parseError,
      };

      // Write sidecar files
      const { mdPath, jsonPath } = await writeRecoverySidecar({
        failedPrdDir: failedDir,
        prdId,
        summary,
        verdict,
      });

      // Emit final recovery:complete with sidecar paths
      yield {
        timestamp: new Date().toISOString(),
        type: 'recovery:complete',
        prdId,
        verdict,
        sidecarMdPath: mdPath,
        sidecarJsonPath: jsonPath,
      };

    } catch (err) {
      // Last-resort outer catch — write degraded sidecar even if something unexpected fails
      const errMsg = err instanceof Error ? err.message : String(err);
      try {
        const summary: BuildFailureSummary = {
          prdId, setName,
          featureBranch: `eforge/${setName}`,
          baseBranch: 'main',
          plans: [],
          failingPlan: { planId: 'unknown' },
          landedCommits: [],
          diffStat: '',
          modelsUsed: [],
          failedAt: new Date().toISOString(),
          partial: true,
        };
        const verdict: RecoveryVerdict = {
          verdict: 'manual',
          confidence: 'low',
          rationale: 'Recovery process failed unexpectedly.',
          completedWork: [],
          remainingWork: [],
          risks: [],
          partial: true,
          recoveryError: errMsg,
        };
        const { mdPath, jsonPath } = await writeRecoverySidecar({ failedPrdDir: failedDir, prdId, summary, verdict });
        yield {
          timestamp: new Date().toISOString(),
          type: 'recovery:complete',
          prdId,
          verdict,
          sidecarMdPath: mdPath,
          sidecarJsonPath: jsonPath,
        };
      } catch {
        // Best-effort — if even sidecar write fails, emit recovery:error
        yield {
          timestamp: new Date().toISOString(),
          type: 'recovery:error',
          prdId,
          error: errMsg,
        };
      }
    }
  }

  /**
   * Apply the recovery verdict for a failed build plan.
   *
   * Reads the recovery sidecar JSON written by `recover()`, validates the verdict,
   * and dispatches to one of four verdict-specific helpers:
   *   - retry: moves the failed PRD back to the queue and removes sidecars
   *   - split: writes the successor PRD to the queue
   *   - abandon: removes the failed PRD and both sidecars
   *   - manual: no-op, returns noAction: true
   *
   * Each mutating dispatch produces exactly one forgeCommit. Never spawns agents.
   * Throws on missing sidecar, validation failure, or missing suggestedSuccessorPrd for split.
   */
  async *applyRecovery(
    setName: string,
    prdId: string,
    _options?: ApplyRecoveryOptions,
  ): AsyncGenerator<EforgeEvent, ApplyRecoveryResult> {
    const cwd = this.cwd;

    // Validate path segments — reject values containing path separators or traversal
    if (
      !setName ||
      !prdId ||
      setName.includes('/') ||
      setName.includes('\\') ||
      setName.includes('..') ||
      prdId.includes('/') ||
      prdId.includes('\\') ||
      prdId.includes('..')
    ) {
      throw new Error('Invalid setName or prdId: must not contain path separators or traversal sequences');
    }

    const queueRelDir = this.config.prdQueue.dir;
    const queueDir = resolve(cwd, queueRelDir);
    const failedDir = join(queueDir, 'failed');
    const sidecarJsonPath = join(failedDir, `${prdId}.recovery.json`);

    yield {
      timestamp: new Date().toISOString(),
      type: 'recovery:apply:start',
      prdId,
      setName,
    };
    yield { timestamp: new Date().toISOString(), type: 'session:profile', profileName: this.configProfile.name, source: this.configProfile.source, scope: this.configProfile.scope, config: this.configProfile.config };

    try {
      // Read the recovery sidecar JSON
      let rawJson: string;
      try {
        rawJson = await readFile(sidecarJsonPath, 'utf-8');
      } catch {
        throw new Error(`Recovery sidecar not found for ${prdId}; run recover() first`);
      }

      // Parse and validate the verdict
      const parsed = JSON.parse(rawJson) as { verdict?: unknown };
      const verdictResult = recoveryVerdictSchema.safeParse(parsed.verdict);
      if (!verdictResult.success) {
        throw new Error(
          `Recovery verdict validation failed for ${prdId}: ${verdictResult.error.message}`,
        );
      }
      const verdict = verdictResult.data;

      const helperOptions = { cwd, prdId, queueDir };

      let result: ApplyRecoveryResult;

      switch (verdict.verdict) {
        case 'retry': {
          const { commitSha } = await applyRecoveryRetry(helperOptions);
          result = { verdict: 'retry', noAction: false, commitSha };
          break;
        }
        case 'split': {
          const { commitSha, successorPrdId } = await applyRecoverySplit(helperOptions, verdict);
          result = { verdict: 'split', noAction: false, commitSha, successorPrdId };
          break;
        }
        case 'abandon': {
          const { commitSha } = await applyRecoveryAbandon(helperOptions);
          result = { verdict: 'abandon', noAction: false, commitSha };
          break;
        }
        case 'manual': {
          await applyRecoveryManual(helperOptions);
          result = { verdict: 'manual', noAction: true };
          break;
        }
        default: {
          // TypeScript exhaustiveness guard
          const _never: never = verdict.verdict;
          throw new Error(`Unknown verdict: ${_never}`);
        }
      }

      yield {
        timestamp: new Date().toISOString(),
        type: 'recovery:apply:complete',
        prdId,
        verdict: result.verdict,
        successorPrdId: result.successorPrdId,
        noAction: result.noAction,
      };

      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      yield {
        timestamp: new Date().toISOString(),
        type: 'recovery:apply:error',
        prdId,
        message,
      };
      throw err;
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
 * Deep-merge config overrides onto base config.
 */
function mergeConfig(base: EforgeConfig, overrides: Partial<EforgeConfig>): EforgeConfig {
  return {
    maxConcurrentBuilds: overrides.maxConcurrentBuilds ?? base.maxConcurrentBuilds,
    langfuse: overrides.langfuse ? { ...base.langfuse, ...overrides.langfuse } : base.langfuse,
    agents: overrides.agents ? { ...base.agents, ...overrides.agents } : base.agents,
    build: overrides.build ? { ...base.build, ...overrides.build } : base.build,
    plan: overrides.plan ? { ...base.plan, ...overrides.plan } : base.plan,
    plugins: overrides.plugins ? { ...base.plugins, ...overrides.plugins } : base.plugins,
    prdQueue: overrides.prdQueue ? { ...base.prdQueue, ...overrides.prdQueue } : base.prdQueue,
    daemon: overrides.daemon ? { ...base.daemon, ...overrides.daemon } : base.daemon,
    monitor: overrides.monitor ? { ...base.monitor, ...overrides.monitor } : base.monitor,
    pi: overrides.pi ? { ...base.pi, ...overrides.pi } : base.pi,
    claudeSdk: overrides.claudeSdk ? { ...base.claudeSdk, ...overrides.claudeSdk } : base.claudeSdk,
    hooks: overrides.hooks ?? base.hooks,
    agentRuntimes: overrides.agentRuntimes ?? base.agentRuntimes,
    defaultAgentRuntime: overrides.defaultAgentRuntime ?? base.defaultAgentRuntime,
  };
}

/**
 * Load MCP server configs from .mcp.json in the given directory.
 * Returns the mcpServers record, or undefined if no .mcp.json exists.
 */
async function loadMcpServers(cwd: string): Promise<ClaudeSDKHarnessOptions['mcpServers'] | undefined> {
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
      // Filter the eforge MCP server to prevent orphaned daemons in agent worktrees
      delete raw.mcpServers['eforge'];
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
          // Skip the eforge plugin itself to prevent orphaned daemons in agent worktrees
          if (id.startsWith('eforge@')) continue;

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

/**
 * EforgeEngine — the sole public API for plan-build-review workflows.
 * All methods return AsyncGenerator<EforgeEvent> (except status() which is synchronous).
 * Engine emits, consumers render — never writes to stdout.
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import type {
  EforgeEvent,
  EforgeStatus,
  CompileOptions,
  BuildOptions,
  EnqueueOptions,
  PlanFile,
  ClarificationQuestion,
} from './events.js';
import { loadQueue, resolveQueueOrder, getHeadHash, getPrdDiffSummary, updatePrdStatus, enqueuePrd, inferTitle, claimPrd, releasePrd } from './prd-queue.js';
import { runStalenessAssessor } from './agents/staleness-assessor.js';
import { runFormatter } from './agents/formatter.js';
import { runDependencyDetector, type QueueItemSummary, type RunningBuildSummary } from './agents/dependency-detector.js';
import type { EforgeConfig, PluginConfig, PartialProfileConfig, BuildStageSpec, ReviewProfileConfig } from './config.js';
import type { AgentBackend } from './backend.js';
import type { ClaudeSDKBackendOptions } from './backends/claude-sdk.js';
import type { SdkPluginConfig, SettingSource } from '@anthropic-ai/claude-agent-sdk';
import { loadConfig, resolveProfileExtensions } from './config.js';
import { ClaudeSDKBackend } from './backends/claude-sdk.js';
import { createTracingContext } from './tracing.js';
import { runValidationFixer } from './agents/validation-fixer.js';
import { runMergeConflictResolver } from './agents/merge-conflict-resolver.js';
import { runPrdValidator } from './agents/prd-validator.js';
import { Orchestrator, type ValidationFixer, type PrdValidator } from './orchestrator.js';
import type { MergeResolver } from './worktree-ops.js';
import { computeWorktreeBase, createMergeWorktree } from './worktree-ops.js';
import { deriveNameFromSource, parseOrchestrationConfig, parsePlanFile, validatePlanSet, validatePlanSetName } from './plan.js';
import { loadState, saveState as saveEforgeState } from './state.js';
import { runCompilePipeline, runBuildPipeline, createToolTracker, type PipelineContext, type BuildStageContext } from './pipeline.js';
import { forgeCommit, retryOnLock } from './git.js';
import { cleanupPlanFiles } from './cleanup.js';
import { Semaphore, AsyncEventQueue } from './concurrency.js';

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
  /** Additional profiles to add to the palette (from --profiles files) */
  profileOverrides?: Record<string, PartialProfileConfig>;
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
  /** Enable custom profile generation (defaults to true) */
  generateProfile?: boolean;
  /** AbortController for cancellation */
  abortController?: AbortController;
  /** Enable watch mode — poll for new PRDs after each cycle */
  watch?: boolean;
  /** Poll interval in milliseconds (overrides config) */
  pollIntervalMs?: number;
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
      bare: config.agents.bare,
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

    // Merge profile overrides from --profiles files
    if (options.profileOverrides) {
      const mergedProfiles = resolveProfileExtensions(options.profileOverrides, config.profiles);
      config = { ...config, profiles: mergedProfiles };
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

    // Validate that a backend is configured
    if (!options.backend && !config.backend) {
      throw new Error(
        'No backend configured. Set `backend: claude-sdk` or `backend: pi` in eforge/config.yaml, ' +
        'or run /eforge:config to set up your configuration.',
      );
    }

    // Select Pi backend from config when no explicit backend is provided
    if (!options.backend && config.backend === 'pi') {
      try {
        const { PiBackend } = await import('./backends/pi.js');
        options = {
          ...options,
          backend: new PiBackend({
            mcpServers: options.mcpServers,
            piConfig: config.pi,
            bare: config.agents.bare,
            extensions: {
              autoDiscover: config.pi.extensions.autoDiscover,
              include: config.pi.extensions.include,
              exclude: config.pi.extensions.exclude,
              paths: config.pi.extensions?.paths,
            },
          }),
        };
      } catch (err) {
        throw new Error(
          'Failed to load Pi backend. Ensure Pi SDK dependencies are installed ' +
          '(@mariozechner/pi-ai and @mariozechner/pi-agent-core). ' +
          `Original error: ${err instanceof Error ? err.message : String(err)}`
        );
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
    const cwd = options.cwd ?? this.cwd;
    let tracing: ReturnType<typeof createTracingContext> | undefined;

    let status: 'completed' | 'failed' = 'completed';
    let summary = 'Compile complete';

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
      // Default profile before planner selection — planner stage updates ctx.profile
      // when it emits plan:profile. Excursion is a safe default (superset of errand stages).
      const selectedProfile = this.config.profiles['excursion'];

      // Create merge worktree — all plan artifact commits go here, not repoRoot
      const featureBranch = `eforge/${planSetName}`;
      const { stdout: baseBranchRaw } = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
      const baseBranch = baseBranchRaw.trim();
      const worktreeBase = computeWorktreeBase(cwd, planSetName);
      const mergeWorktreePath = await createMergeWorktree(cwd, worktreeBase, featureBranch, baseBranch);

      const ctx: PipelineContext = {
        backend: this.backend,
        config: this.config,
        profile: selectedProfile,
        tracing,
        cwd: mergeWorktreePath,
        planCommitCwd: mergeWorktreePath,
        baseBranch,
        planSetName,
        sourceContent,
        verbose: options.verbose,
        auto: options.auto,
        generateProfile: options.generateProfile,
        abortController: options.abortController,
        onClarification: this.onClarification,
        plans: [],
        expeditionModules: [],
        moduleBuildConfigs: new Map(),
      };

      // Run compile pipeline
      yield* runCompilePipeline(ctx);

      // If compile pipeline didn't produce plans and there's no plan-review-cycle
      // in the compile stages, commit artifacts here
      // (runCompilePipeline handles the commit before plan-review-cycle when present)
      if (ctx.plans.length > 0 && !ctx.profile.compile.includes('plan-review-cycle')) {
        const planDir = resolve(mergeWorktreePath, this.config.plan.outputDir, planSetName);
        await exec('git', ['add', planDir], { cwd: mergeWorktreePath });
        await forgeCommit(mergeWorktreePath, `plan(${planSetName}): initial planning artifacts`);
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
      const gen = runFormatter({ backend: this.backend, sourceContent, verbose, abortController });
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
          .filter((p) => p.frontmatter.status === 'pending')
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
          const depGen = runDependencyDetector({
            backend: this.backend,
            prdContent: formattedBody,
            queueItems,
            runningBuilds,
            verbose,
            abortController,
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
        await retryOnLock(() => exec('git', ['add', enqueueResult.filePath], { cwd }), cwd);
        await forgeCommit(cwd, `enqueue(${enqueueResult.id}): ${title}`);
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
      const validation = await validatePlanSet(configPath);
      if (!validation.valid) {
        status = 'failed';
        summary = `Plan set validation failed: ${validation.errors.join('; ')}`;
        return;
      }

      // Load orchestration config
      const orchConfig = await parseOrchestrationConfig(configPath);

      // Pre-load plan files for the runner
      const planDir = resolve(planBaseCwd, this.config.plan.outputDir, planSet);
      const planFileMap = new Map<string, PlanFile>();
      for (const plan of orchConfig.plans) {
        const planFile = await parsePlanFile(resolve(planDir, `${plan.id}.md`));
        planFileMap.set(plan.id, planFile);
      }

      // Per-plan runner closure — iterates build stages from the resolved profile
      const config = this.config;
      const backend = this.backend;
      const verbose = options.verbose;
      const abortController = options.abortController;

      // Use the profile persisted in orchestration.yaml during compile
      const buildProfile = orchConfig.profile;

      const planRunner = async function* (
        planId: string,
        worktreePath: string,
      ): AsyncGenerator<EforgeEvent> {
        const planFile = planFileMap.get(planId);
        if (!planFile) {
          yield { timestamp: new Date().toISOString(), type: 'build:failed', planId, error: `Plan file not found: ${planId}` };
          return;
        }

        // Read per-plan build/review from orchestration.yaml plan entry (required fields)
        const planEntry = orchConfig.plans.find((p) => p.id === planId)!;
        const planBuild: BuildStageSpec[] = planEntry.build;
        const planReview: ReviewProfileConfig = planEntry.review;

        const buildCtx: BuildStageContext = {
          backend,
          config,
          profile: buildProfile,
          tracing: tracing!,
          cwd: worktreePath,
          planSetName: planSet,
          sourceContent: '', // Not needed for build stages
          verbose,
          abortController,
          plans: Array.from(planFileMap.values()),
          expeditionModules: [],
          moduleBuildConfigs: new Map(),
          planId,
          worktreePath,
          planFile,
          orchConfig,
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
          for await (const event of runValidationFixer({
            backend,
            cwd: fixerCwd,
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
          for await (const event of runMergeConflictResolver({
            backend,
            cwd: resolverCwd,
            conflict,
            verbose,
            abortController,
          })) {
            resolverTracker.handleEvent(event);
            mergeEventSink(event);
            if (event.type === 'merge:resolve:complete') {
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

        // Build diff: baseBranch...HEAD truncated at 80K chars
        let diff: string;
        try {
          const { stdout } = await exec('git', ['diff', `${orchConfig.baseBranch}...HEAD`], { cwd: validatorCwd, maxBuffer: 100 * 1024 * 1024 });
          diff = stdout.length > 80_000 ? stdout.slice(0, 80_000) + '\n\n[diff truncated at 80K chars]' : stdout;
        } catch {
          return;
        }

        if (!diff.trim()) return;

        const prdSpan = tracing!.createSpan('prd-validator', {});
        prdSpan.setInput({ prdLength: prdContent.length, diffLength: diff.length });
        const prdTracker = createToolTracker(prdSpan);
        try {
          for await (const event of runPrdValidator({
            backend,
            cwd: validatorCwd,
            prdContent,
            diff,
            verbose,
            abortController,
          })) {
            prdTracker.handleEvent(event);
            yield event;
          }
          prdTracker.cleanup();
          prdSpan.end();
        } catch (err) {
          prdTracker.cleanup();
          prdSpan.error(err as Error);
        }
      } : undefined;

      // Create and run orchestrator
      const parallelism = config.build.parallelism;
      const signal = abortController?.signal;
      const shouldCleanup = options.cleanup ?? this.config.build.cleanupPlanFiles;
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
        mergeResolver,
        prdValidator,
        mergeWorktreePath,
        shouldCleanup,
        cleanupPlanSet: planSet,
        cleanupOutputDir: this.config.plan.outputDir,
        cleanupPrdFilePath: options.prdFilePath,
      });

      for await (const event of orchestrator.execute(orchConfig)) {
        // Drain any buffered merge resolution events before yielding the orchestrator event
        while (mergeEvents.length > 0) {
          yield mergeEvents.shift()!;
        }
        yield event;
        if (event.type === 'build:failed') {
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
      // Clean up state file (gitignored) — must use repo root, not merge worktree
      try { await rm(resolve(cwd, '.eforge', 'state.json')); } catch {}

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
   * Process a single PRD: claim, staleness check, compile, build, release.
   * Extracted from runQueue() so the greedy scheduler can run PRDs concurrently.
   */
  private async *buildSinglePrd(
    prd: import('./prd-queue.js').QueuedPrd,
    options: QueueOptions,
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
      yield { timestamp: new Date().toISOString(), type: 'queue:prd:skip', prdId: prd.id, reason: 'claimed by another process' };
      yield { timestamp: new Date().toISOString(), type: 'queue:prd:complete', prdId: prd.id, status: 'skipped' };
      return;
    }

    // Staleness check — skip only if PRD was added in the most recent commit
    const headHash = await getHeadHash(cwd);
    if (prd.lastCommitHash && prd.lastCommitHash !== headHash) {
      const diffSummary = await getPrdDiffSummary(prd.lastCommitHash, cwd);

      let stalenessVerdict: 'proceed' | 'revise' | 'obsolete' = 'proceed';
      let revision: string | undefined;

      for await (const event of runStalenessAssessor({
        backend: this.backend,
        prdContent: prd.content,
        diffSummary,
        cwd,
        verbose,
        abortController,
      })) {
        if (event.type === 'queue:prd:stale') {
          stalenessVerdict = event.verdict;
          revision = event.revision;
        }
        yield event;
      }

      if (stalenessVerdict === 'obsolete') {
        await releasePrd(prd.id, cwd);
        await updatePrdStatus(prd.filePath, 'skipped');
        yield { timestamp: new Date().toISOString(), type: 'queue:prd:skip', prdId: prd.id, reason: 'obsolete' };
        yield { timestamp: new Date().toISOString(), type: 'queue:prd:complete', prdId: prd.id, status: 'skipped' };
        return;
      }

      if (stalenessVerdict === 'revise') {
        if (this.config.prdQueue.autoRevise && revision) {
          // Auto-apply revision and commit
          await writeFile(prd.filePath, revision, 'utf-8');
          try {
            await retryOnLock(() => exec('git', ['add', '--', prd.filePath], { cwd }), cwd);
            await forgeCommit(cwd, `chore(queue): revise stale PRD ${prd.id}`);
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
          await releasePrd(prd.id, cwd);
          yield { timestamp: new Date().toISOString(), type: 'queue:prd:skip', prdId: prd.id, reason: 'needs revision' };
          yield { timestamp: new Date().toISOString(), type: 'queue:prd:complete', prdId: prd.id, status: 'skipped' };
          return;
        }
      }
    }

    // Per-PRD session: each PRD gets its own sessionId for monitor grouping
    const prdSessionId = randomUUID();
    let prdResult: { status: 'completed' | 'failed' | 'skipped'; summary: string } = {
      status: 'failed',
      summary: 'Session terminated abnormally',
    };

    try {
      // Update status to running
      await updatePrdStatus(prd.filePath, 'running');

      yield {
        type: 'session:start',
        sessionId: prdSessionId,
        timestamp: new Date().toISOString(),
      } as EforgeEvent;

      // Compile (plan) the PRD
      let compileFailed = false;
      let planSkipped = false;
      let skipReason = '';
      const planSetName = options.name ?? prd.id;

      for await (const event of this.compile(prd.filePath, {
        name: planSetName,
        auto: options.auto,
        verbose,
        generateProfile: options.generateProfile ?? true,
        cwd,
        abortController,
      })) {
        yield { ...event, sessionId: prdSessionId } as EforgeEvent;
        if (event.type === 'phase:end' && event.result.status === 'failed') {
          compileFailed = true;
        }
        if (event.type === 'plan:skip') {
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
      for await (const event of this.build(planSetName, {
        auto: options.auto,
        verbose,
        cwd,
        abortController,
        prdFilePath: prd.filePath,
      })) {
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
      try {
        await releasePrd(prd.id, cwd);
      } catch { /* best-effort lock cleanup */ }
      try {
        await updatePrdStatus(prd.filePath, prdResult.status);
      } catch { /* prevent double-throw */ }

      yield {
        type: 'session:end',
        sessionId: prdSessionId,
        result: prdResult,
        timestamp: new Date().toISOString(),
      } as EforgeEvent;
    }

    yield { timestamp: new Date().toISOString(), type: 'queue:prd:complete', prdId: prd.id, status: prdResult.status };
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
    const orderedPrds = options.name
      ? allOrdered.filter((p) => p.id === options.name)
      : allOrdered;

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

    const parallelism = this.config.prdQueue.parallelism;
    const semaphore = new Semaphore(parallelism);
    const eventQueue = new AsyncEventQueue<EforgeEvent>();

    let processed = 0;
    let skipped = 0;

    const startReadyPrds = (): void => {
      for (const prd of orderedPrds) {
        if (abortController?.signal.aborted) break;
        if (!isReady(prd.id)) continue;

        const state = prdState.get(prd.id)!;
        state.status = 'running';

        eventQueue.addProducer();

        // Launch asynchronously — semaphore gates actual execution
        void (async () => {
          let acquired = false;
          let lastCompletionStatus: string | undefined;
          try {
            await semaphore.acquire();
            acquired = true;

            for await (const event of this.buildSinglePrd(prd, options)) {
              if (event.type === 'queue:prd:complete') {
                lastCompletionStatus = (event as { status: string }).status;
              }
              eventQueue.push(event);
            }
          } catch (err) {
            lastCompletionStatus = 'failed';
            eventQueue.push({
              timestamp: new Date().toISOString(),
              type: 'queue:prd:complete',
              prdId: prd.id,
              status: 'failed',
            } as EforgeEvent);
          } finally {
            if (acquired) semaphore.release();

            // Update state based on the actual completion status from buildSinglePrd
            const finalState = prdState.get(prd.id)!;
            if (finalState.status === 'running') {
              if (lastCompletionStatus === 'completed') {
                finalState.status = 'completed';
              } else if (lastCompletionStatus === 'skipped') {
                finalState.status = 'skipped';
              } else {
                finalState.status = 'failed';
              }
            }

            // Propagate blocked on failure
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
        if (completionStatus === 'skipped') {
          skipped++;
        } else {
          processed++;
        }

        // Try to launch newly-unblocked PRDs
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
   * Watch queue: wrap runQueue() in a polling loop, checking for new PRDs
   * after each cycle. Yields queue:watch:* events to communicate state.
   * Exits cleanly when the abort signal fires.
   */
  async *watchQueue(options: QueueOptions = {}): AsyncGenerator<EforgeEvent> {
    const pollIntervalMs = options.pollIntervalMs ?? this.config.prdQueue.watchPollIntervalMs;
    const signal = options.abortController?.signal;

    let totalProcessed = 0;
    let totalSkipped = 0;

    while (!signal?.aborted) {
      // Delegate to runQueue for this cycle, intercepting queue:complete
      let cycleProcessed = 0;
      let cycleSkipped = 0;

      for await (const event of this.runQueue(options)) {
        if (event.type === 'queue:complete') {
          // Swallow queue:complete, emit queue:watch:cycle instead
          cycleProcessed = event.processed;
          cycleSkipped = event.skipped;
        } else {
          yield event;
        }
      }

      totalProcessed += cycleProcessed;
      totalSkipped += cycleSkipped;

      yield {
        timestamp: new Date().toISOString(),
        type: 'queue:watch:cycle',
        processed: cycleProcessed,
        skipped: cycleSkipped,
      };

      // Check abort before sleeping
      if (signal?.aborted) break;

      yield {
        timestamp: new Date().toISOString(),
        type: 'queue:watch:waiting',
        pollIntervalMs,
      };

      const aborted = await abortableSleep(pollIntervalMs, signal);
      if (aborted) break;

      yield { timestamp: new Date().toISOString(), type: 'queue:watch:poll' };
    }

    // Final queue:complete after watch loop exits
    yield {
      timestamp: new Date().toISOString(),
      type: 'queue:complete',
      processed: totalProcessed,
      skipped: totalSkipped,
    };
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
    backend: overrides.backend ?? base.backend,
    langfuse: overrides.langfuse ? { ...base.langfuse, ...overrides.langfuse } : base.langfuse,
    agents: overrides.agents ? { ...base.agents, ...overrides.agents } : base.agents,
    build: overrides.build ? { ...base.build, ...overrides.build } : base.build,
    plan: overrides.plan ? { ...base.plan, ...overrides.plan } : base.plan,
    plugins: overrides.plugins ? { ...base.plugins, ...overrides.plugins } : base.plugins,
    prdQueue: overrides.prdQueue ? { ...base.prdQueue, ...overrides.prdQueue } : base.prdQueue,
    daemon: overrides.daemon ? { ...base.daemon, ...overrides.daemon } : base.daemon,
    monitor: overrides.monitor ? { ...base.monitor, ...overrides.monitor } : base.monitor,
    pi: overrides.pi ? { ...base.pi, ...overrides.pi } : base.pi,
    hooks: overrides.hooks ?? base.hooks,
    profiles: overrides.profiles ?? base.profiles,
  };
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

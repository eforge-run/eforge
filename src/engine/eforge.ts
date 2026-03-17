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
import { loadQueue, resolveQueueOrder, getPrdDiffSummary, updatePrdStatus, enqueuePrd, inferTitle, type QueuedPrd } from './prd-queue.js';
import { runStalenessAssessor } from './agents/staleness-assessor.js';
import { runFormatter } from './agents/formatter.js';
import type { EforgeConfig, PluginConfig, PartialProfileConfig } from './config.js';
import type { AgentBackend } from './backend.js';
import type { ClaudeSDKBackendOptions } from './backends/claude-sdk.js';
import type { SdkPluginConfig, SettingSource } from '@anthropic-ai/claude-agent-sdk';
import { loadConfig, resolveProfileExtensions } from './config.js';
import { ClaudeSDKBackend } from './backends/claude-sdk.js';
import { createTracingContext } from './tracing.js';
import { runValidationFixer } from './agents/validation-fixer.js';
import { runMergeConflictResolver } from './agents/merge-conflict-resolver.js';
import { Orchestrator, type ValidationFixer } from './orchestrator.js';
import type { MergeResolver } from './worktree.js';
import { deriveNameFromSource, parseOrchestrationConfig, parsePlanFile, validatePlanSet, validatePlanSetName } from './plan.js';
import { loadState } from './state.js';
import { runCompilePipeline, runBuildPipeline, createToolTracker, type PipelineContext, type BuildStageContext } from './pipeline.js';

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
  /** AbortController for cancellation */
  abortController?: AbortController;
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
      // Default profile before planner selection — planner stage updates ctx.profile
      // when it emits plan:profile. Excursion is a safe default (superset of errand stages).
      const selectedProfile = this.config.profiles['excursion'];

      const ctx: PipelineContext = {
        backend: this.backend,
        config: this.config,
        profile: selectedProfile,
        tracing,
        cwd,
        planSetName,
        sourceContent,
        verbose: options.verbose,
        auto: options.auto,
        generateProfile: options.generateProfile,
        abortController: options.abortController,
        onClarification: this.onClarification,
        plans: [],
        expeditionModules: [],
      };

      // Run compile pipeline
      yield* runCompilePipeline(ctx);

      // If compile pipeline didn't produce plans and there's no plan-review-cycle
      // in the compile stages, commit artifacts here
      // (runCompilePipeline handles the commit before plan-review-cycle when present)
      if (ctx.plans.length > 0 && !ctx.profile.compile.includes('plan-review-cycle')) {
        const planDir = resolve(cwd, 'plans', planSetName);
        await exec('git', ['add', planDir], { cwd });
        await exec('git', ['commit', '-m', `plan(${planSetName}): initial planning artifacts`], { cwd });
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

    yield { type: 'enqueue:start', source };

    // Infer title from content (or from name override)
    const title = options.name ?? inferTitle(sourceContent, !source.includes('\n') ? source : undefined);

    // Run formatter agent to normalize content
    let formattedBody = sourceContent;
    const gen = runFormatter({ backend: this.backend, sourceContent, verbose, abortController });
    let result = await gen.next();
    while (!result.done) {
      yield result.value;
      result = await gen.next();
    }
    if (result.value?.body) {
      formattedBody = result.value.body;
    }

    // Write to queue
    const enqueueResult = await enqueuePrd({
      body: formattedBody,
      title,
      queueDir: this.config.prdQueue.dir,
      cwd,
    });

    yield {
      type: 'enqueue:complete',
      id: enqueueResult.id,
      filePath: enqueueResult.filePath,
      title,
    };
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

      // Per-plan runner closure — iterates build stages from the resolved profile
      const config = this.config;
      const backend = this.backend;
      const verbose = options.verbose;
      const abortController = options.abortController;

      // Default to excursion profile for build (matches today's hardcoded sequence)
      const buildProfile = config.profiles['excursion'];

      const planRunner = async function* (
        planId: string,
        worktreePath: string,
      ): AsyncGenerator<EforgeEvent> {
        const planFile = planFileMap.get(planId);
        if (!planFile) {
          yield { type: 'build:failed', planId, error: `Plan file not found: ${planId}` };
          return;
        }

        const buildCtx: BuildStageContext = {
          backend,
          config,
          profile: buildProfile,
          tracing,
          cwd: worktreePath,
          planSetName: planSet,
          sourceContent: '', // Not needed for build stages
          verbose,
          abortController,
          plans: Array.from(planFileMap.values()),
          expeditionModules: [],
          planId,
          worktreePath,
          planFile,
          orchConfig,
          reviewIssues: [],
        };

        yield* runBuildPipeline(buildCtx);
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

      // Create merge conflict resolver closure
      const mergeEvents: EforgeEvent[] = [];
      const mergeEventSink = (event: EforgeEvent) => { mergeEvents.push(event); };

      const mergeResolver: MergeResolver = async (repoRoot, conflict) => {
        const resolverSpan = tracing.createSpan('merge-conflict-resolver', {
          branch: conflict.branch,
          files: conflict.conflictedFiles,
        });
        const resolverTracker = createToolTracker(resolverSpan);
        let resolved = false;
        try {
          for await (const event of runMergeConflictResolver({
            backend,
            cwd: repoRoot,
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
        mergeResolver,
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
      }

      // Drain any remaining merge resolution events after orchestrator completes
      while (mergeEvents.length > 0) {
        yield mergeEvents.shift()!;
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
   * Queue: process PRDs from a queue directory sequentially.
   * For each PRD: staleness check → compile → build.
   * Updates frontmatter status as PRDs are processed.
   */
  async *runQueue(options: QueueOptions = {}): AsyncGenerator<EforgeEvent> {
    const cwd = this.cwd;
    const queueDir = this.config.prdQueue.dir;
    const verbose = options.verbose;
    const abortController = options.abortController;

    // Load and order queue
    const allPrds = await loadQueue(queueDir, cwd);
    const orderedPrds = resolveQueueOrder(allPrds);

    yield {
      type: 'queue:start',
      prdCount: orderedPrds.length,
      dir: queueDir,
    };

    let processed = 0;
    let skipped = 0;

    for (const prd of orderedPrds) {
      // Check for abort
      if (abortController?.signal.aborted) break;

      yield {
        type: 'queue:prd:start',
        prdId: prd.id,
        title: prd.frontmatter.title,
      };

      // Staleness check — only if PRD has a commit hash and threshold is configured
      if (prd.lastCommitHash && this.config.prdQueue.stalenessThresholdDays > 0) {
        const daysSinceCommit = prd.lastCommitDate
          ? Math.floor((Date.now() - new Date(prd.lastCommitDate).getTime()) / (1000 * 60 * 60 * 24))
          : 0;

        if (daysSinceCommit >= this.config.prdQueue.stalenessThresholdDays) {
          const diffSummary = await getPrdDiffSummary(prd.lastCommitHash, cwd);

          let stalenessVerdict: 'proceed' | 'revise' | 'obsolete' = 'proceed';
          let revision: string | undefined;

          for await (const event of runStalenessAssessor({
            backend: this.backend,
            prdContent: prd.content,
            diffSummary,
            staleDays: daysSinceCommit,
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
            await updatePrdStatus(prd.filePath, 'skipped');
            yield { type: 'queue:prd:skip', prdId: prd.id, reason: 'obsolete' };
            skipped++;
            continue;
          }

          if (stalenessVerdict === 'revise') {
            if (this.config.prdQueue.autoRevise && revision) {
              // Auto-apply revision
              await writeFile(prd.filePath, revision, 'utf-8');
            } else {
              // Skip — needs manual revision
              yield { type: 'queue:prd:skip', prdId: prd.id, reason: 'needs revision' };
              skipped++;
              continue;
            }
          }
        }
      }

      // Update status to running
      await updatePrdStatus(prd.filePath, 'running');

      // Compile (plan) the PRD
      let compileFailed = false;
      const planSetName = options.name ?? prd.id;

      for await (const event of this.compile(prd.filePath, {
        name: planSetName,
        auto: options.auto,
        verbose,
        cwd,
        abortController,
      })) {
        yield event;
        if (event.type === 'phase:end' && event.result.status === 'failed') {
          compileFailed = true;
        }
      }

      if (compileFailed) {
        await updatePrdStatus(prd.filePath, 'failed');
        yield { type: 'queue:prd:complete', prdId: prd.id, status: 'failed' };
        processed++;
        continue;
      }

      // Build the plan
      let buildFailed = false;
      for await (const event of this.build(planSetName, {
        auto: options.auto,
        verbose,
        cwd,
        abortController,
      })) {
        yield event;
        if (event.type === 'phase:end' && event.result.status === 'failed') {
          buildFailed = true;
        }
      }

      const finalStatus = buildFailed ? 'failed' : 'completed';
      await updatePrdStatus(prd.filePath, finalStatus);
      yield { type: 'queue:prd:complete', prdId: prd.id, status: finalStatus };
      processed++;
    }

    yield {
      type: 'queue:complete',
      processed,
      skipped,
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
    prdQueue: overrides.prdQueue ? { ...base.prdQueue, ...overrides.prdQueue } : base.prdQueue,
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

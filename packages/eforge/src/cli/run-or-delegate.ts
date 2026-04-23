/**
 * `runOrDelegate` — shared tri-branch helper for the `build` and `queue run` commands.
 *
 * The `build` command has three paths:
 *   1. Daemon running + no `--foreground` + no `--dry-run`
 *      → enqueue via daemon API, print session + monitor URL, exit 0
 *   2. `--dry-run`
 *      → in-process enqueue + compile, display execution plan, exit 0
 *   3. Otherwise (daemon unavailable, --foreground, etc.)
 *      → in-process enqueue + engine.runQueue against just-enqueued name
 *
 * The `queue run` command always uses path 3 (no `--dry-run`, no delegation),
 * but funnelling it through the same helper ensures a single in-process
 * implementation and consistent error formatting via `formatCliError`.
 */

import chalk from 'chalk';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { EforgeEngine } from '@eforge-build/engine/eforge';
import {
  validatePlanSet,
  parseOrchestrationConfig,
  resolveDependencyGraph,
  validateRuntimeReadiness,
} from '@eforge-build/engine/plan';
import type { EforgeConfig, HookConfig } from '@eforge-build/engine/config';
import type { EforgeEvent } from '@eforge-build/engine/events';
import { withHooks } from '@eforge-build/engine/hooks';
import { withSessionId, withRunId, runSession } from '@eforge-build/engine/session';
import { ensureMonitor, type Monitor } from '@eforge-build/monitor';
import {
  readLockfile,
  apiEnqueue,
} from '@eforge-build/client';
import type { EnqueueResponse } from '@eforge-build/client';
import {
  initDisplay,
  renderEvent,
  renderDryRun,
  renderLangfuseStatus,
  stopAllSpinners,
} from './display.js';
import { createClarificationHandler, createApprovalHandler } from './interactive.js';
import { formatCliError } from './errors.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Return value from `runOrDelegate`. Convert to `process.exit(code)`. */
export interface CliExitInfo {
  code: number;
}

/** Options for the `build` command (non-queue, non-watch path). */
export interface BuildRunOpts {
  mode: 'build';
  source: string;
  options: {
    auto?: boolean;
    verbose?: boolean;
    name?: string;
    dryRun?: boolean;
    foreground?: boolean;
    monitor?: boolean;
    plugins?: boolean;
    cleanup?: boolean;
    maxConcurrentBuilds?: number;
  };
  abortController?: AbortController;
  /** Called with the active monitor on start and undefined on teardown. */
  onMonitor?: (monitor: Monitor | undefined) => void;
}

/** Options for the `queue run` command. */
export interface QueueRunOpts {
  mode: 'queue';
  name?: string;
  options: {
    all?: boolean;
    auto?: boolean;
    verbose?: boolean;
    monitor?: boolean;
    plugins?: boolean;
    maxConcurrentBuilds?: number;
    watch?: boolean;
    pollInterval?: number;
  };
  abortController?: AbortController;
  /** Called with the active monitor on start and undefined on teardown. */
  onMonitor?: (monitor: Monitor | undefined) => void;
}

export type RunOrDelegateOpts = BuildRunOpts | QueueRunOpts;

// ---------------------------------------------------------------------------
// Internal helpers (mirroring index.ts conventions)
// ---------------------------------------------------------------------------

function buildConfigOverrides(options: {
  maxConcurrentBuilds?: number;
  plugins?: boolean;
}): Partial<EforgeConfig> | undefined {
  const overrides: Partial<EforgeConfig> = {};
  if (options.maxConcurrentBuilds !== undefined) {
    overrides.maxConcurrentBuilds = options.maxConcurrentBuilds;
  }
  if (options.plugins === false) overrides.plugins = { enabled: false };
  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

function wrapEvents(
  events: AsyncGenerator<EforgeEvent>,
  monitor: Monitor,
  hooks: readonly HookConfig[],
  sessionOpts?: import('@eforge-build/engine/session').SessionOptions,
): AsyncGenerator<EforgeEvent> {
  let wrapped = sessionOpts ? withSessionId(events, sessionOpts) : events;
  wrapped = withRunId(wrapped);
  if (hooks.length > 0) {
    wrapped = withHooks(wrapped, hooks, process.cwd());
  }
  return monitor.wrapEvents(wrapped);
}

async function consumeEvents(
  events: AsyncGenerator<EforgeEvent>,
  opts?: { afterStart?: () => void },
): Promise<'completed' | 'failed' | 'skipped'> {
  let result: 'completed' | 'failed' | 'skipped' = 'completed';
  for await (const event of events) {
    renderEvent(event);
    if (event.type === 'phase:start' && opts?.afterStart) {
      opts.afterStart();
    }
    if (event.type === 'phase:end') {
      result = event.result.status;
    }
  }
  return result;
}

async function withRunMonitor<T>(
  noServer: boolean | undefined,
  fn: (monitor: Monitor) => Promise<T>,
  onMonitor?: (monitor: Monitor | undefined) => void,
): Promise<T> {
  const monitor = await ensureMonitor(process.cwd(), { noServer: noServer ?? false });
  onMonitor?.(monitor);
  if (monitor.server) {
    if (monitor.server.port !== 4567) {
      console.error(chalk.green.bold(`  Monitor: ${monitor.server.url}`));
    } else {
      console.error(chalk.dim(`  Monitor: ${monitor.server.url}`));
    }
  }
  try {
    return await fn(monitor);
  } finally {
    monitor.stop();
    onMonitor?.(undefined);
  }
}

/** Run compile + show dry-run execution plan. Returns exit code. */
async function runDryRun(
  engine: ReturnType<typeof EforgeEngine.create> extends Promise<infer T> ? T : never,
  enqueuedName: string,
  options: { auto?: boolean; verbose?: boolean; name?: string; monitor?: boolean },
  abortController?: AbortController,
  onMonitor?: (monitor: Monitor | undefined) => void,
): Promise<CliExitInfo> {
  let planSetName: string | undefined;
  let compileResult: 'completed' | 'failed' | 'skipped' = 'completed';

  await withRunMonitor(options.monitor === false, async (monitor) => {
    const compileSessionId = randomUUID();

    const { loadQueue } = await import('@eforge-build/engine/prd-queue');
    const prds = await loadQueue(engine.resolvedConfig.prdQueue.dir, process.cwd());
    const prd = prds.find((p) => p.id === enqueuedName || p.frontmatter.title === enqueuedName);
    if (!prd) {
      console.error(chalk.red(`Could not find enqueued PRD: ${enqueuedName}`));
      compileResult = 'failed';
      return;
    }

    const compileEvents = engine.compile(prd.filePath, {
      auto: options.auto,
      verbose: options.verbose,
      name: options.name,
      abortController,
    });

    const wrapped = wrapEvents(
      runSession(compileEvents, compileSessionId),
      monitor,
      engine.resolvedConfig.hooks,
    );

    for await (const event of wrapped) {
      renderEvent(event);
      if (event.type === 'phase:start') {
        planSetName = event.planSet;
        renderLangfuseStatus(engine.resolvedConfig);
      }
      if (event.type === 'phase:end') {
        compileResult = event.result.status;
      }
    }
  }, onMonitor);

  if (planSetName && compileResult === 'completed') {
    const cwd = process.cwd();
    const { loadConfig } = await import('@eforge-build/engine/config');
    const resolvedConfig = await loadConfig(cwd);
    const configPath = resolve(cwd, resolvedConfig.plan.outputDir, planSetName, 'orchestration.yaml');
    const validation = await validatePlanSet(configPath);
    if (!validation.valid) {
      console.error(
        `Validation failed:\n${validation.errors.map((e) => `  - ${e}`).join('\n')}`,
      );
      return { code: 1 };
    }
    const config = await parseOrchestrationConfig(configPath);
    const { waves, mergeOrder } = resolveDependencyGraph(config.plans);

    const warnings = await validateRuntimeReadiness(cwd, config.plans);
    if (warnings.length > 0) {
      console.log('');
      console.log(chalk.yellow('⚠ Runtime readiness warnings:'));
      for (const warning of warnings) {
        console.log(chalk.yellow(`  - ${warning}`));
      }
    }

    renderDryRun(config, waves, mergeOrder);
    return { code: 0 };
  }

  return { code: compileResult === 'completed' ? 0 : 1 };
}

// ---------------------------------------------------------------------------
// runOrDelegate
// ---------------------------------------------------------------------------

/**
 * Encapsulates the `build` and `queue run` command execution paths.
 *
 * Returns a `CliExitInfo`; the caller converts it to `process.exit(code)`.
 * Errors that escape are formatted via `formatCliError` before being printed.
 */
export async function runOrDelegate(opts: RunOrDelegateOpts): Promise<CliExitInfo> {
  if (opts.mode === 'build') {
    return runBuild(opts);
  }
  return runQueue(opts);
}

async function runBuild(opts: BuildRunOpts): Promise<CliExitInfo> {
  const { source, options, abortController, onMonitor } = opts;
  const cwd = process.cwd();

  // Path 1: Delegate to daemon when it is already running
  if (!options.foreground && !options.dryRun) {
    const lock = readLockfile(cwd);
    if (lock) {
      try {
        const { data } = await apiEnqueue({ cwd, body: { source } });
        const result = data as EnqueueResponse;
        const sessionId = result?.sessionId ?? 'unknown';
        console.log(chalk.green(`PRD enqueued (session: ${sessionId}). Daemon will auto-build.`));

        const currentLock = readLockfile(cwd);
        if (currentLock) {
          if (currentLock.port !== 4567) {
            console.log(chalk.green.bold(`  Monitor: http://localhost:${currentLock.port}`));
          } else {
            console.log(chalk.dim(`  Monitor: http://localhost:${currentLock.port}`));
          }
        }

        return { code: 0 };
      } catch (err) {
        const { message } = formatCliError(err);
        console.error(chalk.yellow(`⚠ Daemon unavailable: ${message}`));
        console.error(chalk.dim('Falling back to in-process execution'));
        // fall through to in-process
      }
    }
  }

  // Path 2 & 3: In-process (enqueue + optional compile/dry-run + runQueue)
  initDisplay({ verbose: options.verbose });

  const configOverrides = buildConfigOverrides(options);
  const engine = await EforgeEngine.create({
    onClarification: createClarificationHandler(options.auto ?? false),
    onApproval: createApprovalHandler(options.auto ?? false),
    ...(configOverrides && { config: configOverrides }),
  });

  // Phase 1: Enqueue
  let enqueuedName: string | undefined;
  let enqueueResult: 'completed' | 'failed' | 'skipped' = 'completed';
  const enqueueSessionId = randomUUID();

  await withRunMonitor(options.monitor === false, async (monitor) => {
    const enqueueEvents = engine.enqueue(source, {
      name: options.name,
      verbose: options.verbose,
      abortController,
    });

    const wrapped = wrapEvents(
      runSession(enqueueEvents, enqueueSessionId),
      monitor,
      engine.resolvedConfig.hooks,
    );

    for await (const event of wrapped) {
      renderEvent(event);
      if (event.type === 'enqueue:complete') {
        enqueuedName = options.name ?? event.id;
      }
      if (event.type === 'session:end') {
        enqueueResult = event.result.status;
      }
    }
  }, onMonitor);

  if (enqueueResult !== 'completed' || !enqueuedName) {
    console.error(chalk.red('Enqueue failed'));
    return { code: 1 };
  }

  // Path 2: --dry-run
  if (options.dryRun) {
    return runDryRun(engine, enqueuedName, options, abortController, onMonitor);
  }

  // Path 3: Run queue for just-enqueued PRD
  let buildCode = 1;
  await withRunMonitor(options.monitor === false, async (monitor) => {
    const queueEvents = engine.runQueue({
      name: enqueuedName,
      auto: options.auto,
      verbose: options.verbose,
      abortController,
    });

    const result = await consumeEvents(
      wrapEvents(queueEvents, monitor, engine.resolvedConfig.hooks),
      { afterStart: () => renderLangfuseStatus(engine.resolvedConfig) },
    );

    buildCode = result === 'completed' ? 0 : 1;
  }, onMonitor);

  return { code: buildCode };
}

async function runQueue(opts: QueueRunOpts): Promise<CliExitInfo> {
  const { name, options, abortController, onMonitor } = opts;

  initDisplay({ verbose: options.verbose });

  const configOverrides = buildConfigOverrides(options);
  const engine = await EforgeEngine.create({
    onClarification: createClarificationHandler(options.auto ?? false),
    onApproval: createApprovalHandler(options.auto ?? false),
    ...(configOverrides && { config: configOverrides }),
  });

  let queueCode = 0;
  await withRunMonitor(options.monitor === false, async (monitor) => {
    const queueOpts = {
      name,
      all: options.all,
      auto: options.auto,
      verbose: options.verbose,
      abortController,
      ...(options.pollInterval !== undefined && { pollIntervalMs: options.pollInterval }),
    };

    const queueEvents = options.watch
      ? engine.watchQueue(queueOpts)
      : engine.runQueue(queueOpts);

    const result = await consumeEvents(
      wrapEvents(queueEvents, monitor, engine.resolvedConfig.hooks),
      { afterStart: () => renderLangfuseStatus(engine.resolvedConfig) },
    );

    // In watch mode, abort is a clean exit
    queueCode = options.watch ? 0 : result === 'completed' ? 0 : 1;
  }, onMonitor);

  return { code: queueCode };
}

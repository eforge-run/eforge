import { Command } from 'commander';
import chalk from 'chalk';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { EforgeEngine } from '../engine/eforge.js';
import {
  validatePlanSet,
  parseOrchestrationConfig,
  resolveDependencyGraph,
  validateRuntimeReadiness,
} from '../engine/plan.js';
import type { EforgeConfig, HookConfig } from '../engine/config.js';
import type { EforgeEvent } from '../engine/events.js';
import { withHooks } from '../engine/hooks.js';
import { withSessionId, runSession } from '../engine/session.js';
import { initDisplay, renderEvent, renderStatus, renderDryRun, renderLangfuseStatus, renderQueueList, stopAllSpinners } from './display.js';
import { createClarificationHandler, createApprovalHandler } from './interactive.js';
import { ensureMonitor, signalMonitorShutdown, type Monitor } from '../monitor/index.js';
import { readLockfile, isServerAlive, isPidAlive, lockfilePath, removeLockfile } from '../monitor/lockfile.js';

const SHUTDOWN_TIMEOUT_MS = 5000;

function buildConfigOverrides(options: { parallelism?: number; plugins?: boolean }): Partial<EforgeConfig> | undefined {
  const overrides: Partial<EforgeConfig> = {};
  if (options.parallelism) overrides.build = { parallelism: options.parallelism } as EforgeConfig['build'];
  if (options.plugins === false) overrides.plugins = { enabled: false };
  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

let activeMonitor: Monitor | undefined;

function setupSignalHandlers(): AbortController {
  const controller = new AbortController();
  const handler = () => {
    controller.abort();
    stopAllSpinners();
    const timer = setTimeout(() => process.exit(130), SHUTDOWN_TIMEOUT_MS);
    timer.unref();
    if (activeMonitor) {
      try { activeMonitor.stop(); } catch {}
      activeMonitor = undefined;
    }
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
  return controller;
}

async function withMonitor<T>(
  noServer: boolean | undefined,
  fn: (monitor: Monitor) => Promise<T>,
): Promise<T> {
  const monitor = await ensureMonitor(process.cwd(), { noServer: noServer ?? false });
  activeMonitor = monitor;
  if (monitor.server) {
    console.error(chalk.dim(`  Monitor: ${monitor.server.url}`));
  }

  try {
    return await fn(monitor);
  } finally {
    if (activeMonitor) {
      monitor.stop();
      activeMonitor = undefined;
    }
  }
}

function wrapEvents(
  events: AsyncGenerator<EforgeEvent>,
  monitor: Monitor,
  hooks: readonly HookConfig[],
  sessionOpts?: import('../engine/session.js').SessionOptions,
): AsyncGenerator<EforgeEvent> {
  let wrapped = sessionOpts ? withSessionId(events, sessionOpts) : events;
  if (hooks.length > 0) {
    wrapped = withHooks(wrapped, hooks, process.cwd());
  }
  return monitor.wrapEvents(wrapped);
}

async function consumeEvents(
  events: AsyncGenerator<EforgeEvent>,
  opts?: { afterStart?: () => void },
): Promise<'completed' | 'failed'> {
  let result: 'completed' | 'failed' = 'completed';
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

async function showDryRun(planSet: string): Promise<never> {
  const cwd = process.cwd();
  const configPath = resolve(cwd, 'plans', planSet, 'orchestration.yaml');
  const validation = await validatePlanSet(configPath);
  if (!validation.valid) {
    console.error(
      `Validation failed:\n${validation.errors.map((e) => `  - ${e}`).join('\n')}`,
    );
    process.exit(1);
  }
  const config = await parseOrchestrationConfig(configPath);
  const { waves, mergeOrder } = resolveDependencyGraph(config.plans);

  // Runtime readiness warnings
  const warnings = await validateRuntimeReadiness(cwd, config.plans);
  if (warnings.length > 0) {
    console.log('');
    console.log(chalk.yellow('\u26a0 Runtime readiness warnings:'));
    for (const warning of warnings) {
      console.log(chalk.yellow(`  - ${warning}`));
    }
  }

  renderDryRun(config, waves, mergeOrder);
  process.exit(0);
}

export function createProgram(abortController?: AbortController): Command {
  const program = new Command();

  program
    .name('eforge')
    .description('Autonomous plan-build-review CLI for code generation')
    .version('0.1.0');

  program
    .command('enqueue <source>')
    .description('Normalize input and add it to the PRD queue')
    .option('--name <name>', 'Override the inferred PRD title')
    .option('--verbose', 'Stream agent output')
    .option('--no-plugins', 'Disable plugin loading')
    .action(
      async (
        source: string,
        options: {
          name?: string;
          verbose?: boolean;
          plugins?: boolean;
        },
      ) => {
        initDisplay({ verbose: options.verbose });

        const configOverrides = buildConfigOverrides(options);

        const engine = await EforgeEngine.create({
          ...(configOverrides && { config: configOverrides }),
        });

        await withMonitor(true /* noServer */, async (monitor) => {
          const sessionId = randomUUID();

          const enqueueEvents = engine.enqueue(source, {
            name: options.name,
            verbose: options.verbose,
            abortController,
          });

          await consumeEvents(
            wrapEvents(runSession(enqueueEvents, sessionId), monitor, engine.resolvedConfig.hooks),
          );
        });
      },
    );

  const buildCmd = program
    .command('build [source]')
    .alias('run')
    .description('Compile + build + validate in one step')
    .option('--auto', 'Run without approval gates')
    .option('--verbose', 'Stream agent output')
    .option('--name <name>', 'Plan set name (inferred from source if omitted)')
    .option('--queue', 'Process all PRDs from the queue')
    .option('--parallelism <n>', 'Max parallel plans', parseInt)
    .option('--dry-run', 'Compile only, then show execution plan without building')
    .option('--foreground', 'Run in-process instead of delegating to daemon')
    .option('--no-cleanup', 'Keep plan files after successful build')
    .option('--no-monitor', 'Disable web monitor')
    .option('--no-plugins', 'Disable plugin loading')
    .option('--profiles <paths...>', 'Additional workflow profile files to load')
    .option('--no-generate-profile', 'Disable custom profile generation (enabled by default)')
    .option('--watch', 'Watch mode: continuously poll the queue for new PRDs')
    .option('--poll-interval <ms>', 'Poll interval in milliseconds for watch mode', parseInt)
    .action(
      async (
        source: string | undefined,
        options: {
          auto?: boolean;
          verbose?: boolean;
          name?: string;
          queue?: boolean;
          cleanup?: boolean;
          parallelism?: number;
          dryRun?: boolean;
          foreground?: boolean;
          monitor?: boolean;
          plugins?: boolean;
          profiles?: string[];
          generateProfile?: boolean;
          watch?: boolean;
          pollInterval?: number;
        },
      ) => {
        // --queue mode: delegate to engine.runQueue() or engine.watchQueue()
        if (options.queue) {
          initDisplay({ verbose: options.verbose });

          const configOverrides = buildConfigOverrides(options);

          const engine = await EforgeEngine.create({
            onClarification: createClarificationHandler(options.auto ?? false),
            onApproval: createApprovalHandler(options.auto ?? false),
            ...(configOverrides && { config: configOverrides }),
          });

          await withMonitor(options.monitor === false, async (monitor) => {
            const queueOpts = {
              name: options.name,
              all: true,
              auto: options.auto,
              verbose: options.verbose,
              generateProfile: options.generateProfile,
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
            process.exit(options.watch ? 0 : (result === 'completed' ? 0 : 1));
          });
          return;
        }

        // Default path: delegate to daemon when source is provided and no special flags
        if (source && !options.foreground && !options.queue && !options.dryRun) {
          try {
            const { ensureDaemon, daemonRequest } = await import('./daemon-client.js');
            const cwd = process.cwd();
            await ensureDaemon(cwd);
            const result = await daemonRequest(cwd, 'POST', '/api/enqueue', { source }) as { sessionId?: string };
            const sessionId = result?.sessionId ?? 'unknown';
            console.log(chalk.green(`PRD enqueued (session: ${sessionId}). Daemon will auto-build.`));

            // Show monitor URL if daemon is running
            const lock = readLockfile(cwd);
            if (lock) {
              console.log(chalk.dim(`  Monitor: http://localhost:${lock.port}`));
            }

            process.exit(0);
          } catch (err) {
            console.error(chalk.yellow(`⚠ Daemon unavailable, falling back to foreground execution`));
            console.error(chalk.dim(err instanceof Error ? err.message : String(err)));
            // Fall through to in-process execution
          }
        }

        // Normal mode: source is required
        if (!source) {
          console.error(chalk.red('Error: <source> is required unless --queue is specified'));
          process.exit(1);
        }

        initDisplay({ verbose: options.verbose });

        const configOverrides = buildConfigOverrides(options);

        // Parse --profiles files into profile overrides
        let profileOverrides: Record<string, import('../engine/config.js').PartialProfileConfig> | undefined;
        if (options.profiles?.length) {
          const { parseProfilesFile } = await import('../engine/config.js');
          profileOverrides = {};
          for (const profilePath of options.profiles) {
            const resolvedPath = resolve(profilePath);
            let parsed: Record<string, import('../engine/config.js').PartialProfileConfig>;
            try {
              parsed = await parseProfilesFile(resolvedPath);
            } catch (err) {
              console.error(chalk.red(`Error loading profiles file: ${resolvedPath}`));
              console.error(chalk.dim(err instanceof Error ? err.message : String(err)));
              process.exit(1);
            }
            // Later files override earlier ones for same-name profiles
            Object.assign(profileOverrides, parsed);
          }
          if (Object.keys(profileOverrides).length === 0) {
            profileOverrides = undefined;
          }
        }

        const engine = await EforgeEngine.create({
          onClarification: createClarificationHandler(options.auto ?? false),
          onApproval: createApprovalHandler(options.auto ?? false),
          ...(configOverrides && { config: configOverrides }),
          ...(profileOverrides && { profileOverrides }),
        });

        // Phase 1: Enqueue — format and add to queue, capture file path and name
        let enqueuedName: string | undefined;
        let enqueueResult = 'completed' as 'completed' | 'failed';

        const enqueueSessionId = randomUUID();

        await withMonitor(options.monitor === false, async (monitor) => {
          const enqueueEvents = engine.enqueue(source!, {
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
        });

        if (enqueueResult === 'failed' || !enqueuedName) {
          console.error(chalk.red('Enqueue failed'));
          process.exit(1);
        }

        // --dry-run: compile only, then show execution plan
        if (options.dryRun) {
          // For dry-run, we need to compile the enqueued PRD to generate plans,
          // then display the execution plan without building
          let planSetName: string | undefined;
          let compileResult: 'completed' | 'failed' = 'completed';

          await withMonitor(options.monitor === false, async (monitor) => {
            const compileSessionId = randomUUID();

            // Find the enqueued PRD file path from the queue
            const { loadQueue } = await import('../engine/prd-queue.js');
            const prds = await loadQueue(engine.resolvedConfig.prdQueue.dir, process.cwd());
            const prd = prds.find((p) => p.id === enqueuedName || p.frontmatter.title === enqueuedName);
            if (!prd) {
              console.error(chalk.red(`Could not find enqueued PRD: ${enqueuedName}`));
              process.exit(1);
            }

            const compileEvents = engine.compile(prd.filePath, {
              auto: options.auto,
              verbose: options.verbose,
              name: options.name,
              generateProfile: options.generateProfile,
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
          });

          if (planSetName && compileResult === 'completed') {
            await showDryRun(planSetName);
          }
          process.exit(compileResult === 'completed' ? 0 : 1);
        }

        // Phase 2: Run queue to process the just-enqueued PRD
        await withMonitor(options.monitor === false, async (monitor) => {
          const queueEvents = engine.runQueue({
            name: enqueuedName,
            auto: options.auto,
            verbose: options.verbose,
            generateProfile: options.generateProfile,
            abortController,
          });

          const result = await consumeEvents(
            wrapEvents(queueEvents, monitor, engine.resolvedConfig.hooks),
            { afterStart: () => renderLangfuseStatus(engine.resolvedConfig) },
          );

          process.exit(result === 'completed' ? 0 : 1);
        });
      },
    );

  program
    .command('monitor')
    .description('Start or connect to the monitor dashboard')
    .option('--port <port>', 'Preferred port', parseInt)
    .action(async (options: { port?: number }) => {
      const cwd = process.cwd();
      const monitor = await ensureMonitor(cwd, { port: options.port });

      if (!monitor.server) {
        console.error(chalk.red('Failed to start monitor server'));
        process.exit(1);
      }
      console.log(chalk.bold(`Monitor: ${monitor.server.url}`));
      console.log(chalk.dim('Press Ctrl+C to exit'));

      // Signal handlers don't keep the event loop alive — use a timer
      const keepAlive = setInterval(() => {}, 1 << 30);

      await new Promise<void>((resolveWait) => {
        const handler = async () => {
          process.removeListener('SIGINT', handler);
          process.removeListener('SIGTERM', handler);

          monitor.stop();

          // If no active runs remain, signal the detached server to shut down
          await signalMonitorShutdown(cwd);

          clearInterval(keepAlive);
          resolveWait();
        };

        process.on('SIGINT', handler);
        process.on('SIGTERM', handler);
      });
    });

  program
    .command('status')
    .description('Check running builds')
    .action(async () => {
      const engine = await EforgeEngine.create();
      renderStatus(engine.status());
    });

  // Queue commands
  const queue = program
    .command('queue')
    .description('Manage PRD queue');

  queue
    .command('list')
    .description('Show PRDs in the queue')
    .action(async () => {
      const { loadQueue } = await import('../engine/prd-queue.js');
      const { loadConfig } = await import('../engine/config.js');
      const config = await loadConfig();
      const prds = await loadQueue(config.prdQueue.dir, process.cwd());
      renderQueueList(prds);
    });

  queue
    .command('run [name]')
    .description('Process PRDs from the queue')
    .option('--all', 'Process all pending PRDs')
    .option('--auto', 'Run without approval gates')
    .option('--verbose', 'Stream agent output')
    .option('--no-monitor', 'Disable web monitor')
    .option('--no-plugins', 'Disable plugin loading')
    .option('--parallelism <n>', 'Max parallel plans', parseInt)
    .option('--watch', 'Watch mode: continuously poll the queue for new PRDs')
    .option('--poll-interval <ms>', 'Poll interval in milliseconds for watch mode', parseInt)
    .action(
      async (
        name: string | undefined,
        options: {
          all?: boolean;
          auto?: boolean;
          verbose?: boolean;
          monitor?: boolean;
          plugins?: boolean;
          parallelism?: number;
          watch?: boolean;
          pollInterval?: number;
        },
      ) => {
        initDisplay({ verbose: options.verbose });

        const configOverrides = buildConfigOverrides(options);

        const engine = await EforgeEngine.create({
          onClarification: createClarificationHandler(options.auto ?? false),
          onApproval: createApprovalHandler(options.auto ?? false),
          ...(configOverrides && { config: configOverrides }),
        });

        await withMonitor(options.monitor === false, async (monitor) => {
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
          process.exit(options.watch ? 0 : (result === 'completed' ? 0 : 1));
        });
      },
    );

  // Config commands
  const config = program
    .command('config')
    .description('Manage eforge configuration');

  config
    .command('validate')
    .description('Validate eforge.yaml configuration')
    .action(async () => {
      const { validateConfigFile } = await import('../engine/config.js');
      const result = await validateConfigFile();
      if (result.valid) {
        console.log(chalk.green('✔') + ' Config valid');
      } else {
        console.error(chalk.red('✘') + ' Config invalid:');
        for (const err of result.errors) {
          console.error(chalk.red(`  - ${err}`));
        }
        process.exit(1);
      }
    });

  config
    .command('show')
    .description('Show resolved eforge configuration')
    .action(async () => {
      const { loadConfig } = await import('../engine/config.js');
      const { stringify } = await import('yaml');
      const resolved = await loadConfig();
      console.log(stringify(resolved));
    });

  // Daemon commands
  const daemon = program
    .command('daemon')
    .description('Manage persistent daemon server');

  daemon
    .command('start')
    .description('Start the persistent daemon server')
    .option('--port <port>', 'Preferred port', parseInt)
    .action(async (options: { port?: number }) => {
      const cwd = process.cwd();
      const dbPath = resolve(cwd, '.eforge', 'monitor.db');
      const preferredPort = options.port ?? 4567;

      // Check if daemon is already running
      const existingLock = readLockfile(cwd);
      if (existingLock) {
        const alive = await isServerAlive(existingLock);
        if (alive) {
          console.log(chalk.yellow(`Daemon already running at http://localhost:${existingLock.port} (PID ${existingLock.pid})`));
          process.exit(0);
        }
        // Stale lockfile — clean it up
        removeLockfile(cwd);
      }

      // Spawn detached server-main with --persistent flag
      const { accessSync } = await import('node:fs');
      const { dirname: dirnameFn } = await import('node:path');
      const { fileURLToPath: fileURLToPathFn } = await import('node:url');
      const { fork } = await import('node:child_process');

      // Resolve server-main entry point
      const __dirname = dirnameFn(fileURLToPathFn(import.meta.url));
      let serverMainPath: string;
      const jsPath = resolve(__dirname, '..', 'monitor', 'server-main.js');
      const tsPath = resolve(__dirname, '..', 'monitor', 'server-main.ts');

      // In bundled mode, server-main.js is alongside cli.js in dist/
      const bundledPath = resolve(__dirname, 'server-main.js');

      try {
        accessSync(bundledPath);
        serverMainPath = bundledPath;
      } catch {
        try {
          accessSync(jsPath);
          serverMainPath = jsPath;
        } catch {
          try {
            accessSync(tsPath);
            serverMainPath = tsPath;
          } catch {
            console.error(chalk.red('Could not find server-main entry point'));
            process.exit(1);
          }
        }
      }

      const child = fork(serverMainPath, [dbPath, String(preferredPort), cwd, '--persistent'], {
        detached: true,
        stdio: 'ignore',
        execArgv: [...process.execArgv, '--disable-warning=ExperimentalWarning'],
      });

      child.on('error', (err) => {
        console.error(chalk.red(`Failed to start daemon: ${err.message}`));
        process.exit(1);
      });

      child.unref();
      child.disconnect?.();

      // Wait for lockfile to appear
      const maxRetries = 40;
      const retryInterval = 250;
      let lock: Awaited<ReturnType<typeof readLockfile>> = null;

      for (let i = 0; i < maxRetries; i++) {
        await new Promise((r) => setTimeout(r, retryInterval));
        lock = readLockfile(cwd);
        if (lock) {
          const alive = await isServerAlive(lock);
          if (alive) break;
          lock = null;
        }
      }

      if (!lock) {
        console.error(chalk.red('Daemon failed to start within timeout'));
        process.exit(1);
      }

      console.log(chalk.green(`Daemon started at http://localhost:${lock.port} (PID ${lock.pid})`));
    });

  daemon
    .command('stop')
    .description('Stop the persistent daemon server')
    .action(async () => {
      const cwd = process.cwd();
      const lock = readLockfile(cwd);

      if (!lock) {
        console.log(chalk.yellow('Daemon is not running'));
        process.exit(0);
      }

      if (!isPidAlive(lock.pid)) {
        // Stale lockfile
        removeLockfile(cwd);
        console.log(chalk.yellow('Daemon was not running (stale lockfile removed)'));
        process.exit(0);
      }

      // Send SIGTERM
      try {
        process.kill(lock.pid, 'SIGTERM');
      } catch {
        removeLockfile(cwd);
        console.log(chalk.yellow('Daemon process not found (lockfile removed)'));
        process.exit(0);
      }

      // Wait for lockfile removal (daemon's shutdown handler removes it)
      const maxRetries = 20;
      const retryInterval = 250;

      for (let i = 0; i < maxRetries; i++) {
        await new Promise((r) => setTimeout(r, retryInterval));
        const stillExists = readLockfile(cwd);
        if (!stillExists) {
          console.log(chalk.green('Daemon stopped'));
          process.exit(0);
        }
      }

      console.log(chalk.yellow('Daemon may still be shutting down (lockfile still present)'));
      process.exit(0);
    });

  daemon
    .command('status')
    .description('Show daemon status')
    .action(async () => {
      const cwd = process.cwd();
      const lock = readLockfile(cwd);

      if (!lock) {
        console.log(chalk.dim('Daemon is not running'));
        process.exit(0);
      }

      const alive = await isServerAlive(lock);
      if (!alive) {
        removeLockfile(cwd);
        console.log(chalk.yellow('Daemon is not running (stale lockfile removed)'));
        process.exit(0);
      }

      const startedAt = new Date(lock.startedAt);
      const uptimeMs = Date.now() - startedAt.getTime();
      const uptimeSec = Math.floor(uptimeMs / 1000);
      const uptimeMin = Math.floor(uptimeSec / 60);
      const uptimeHr = Math.floor(uptimeMin / 60);

      let uptimeStr: string;
      if (uptimeHr > 0) {
        uptimeStr = `${uptimeHr}h ${uptimeMin % 60}m`;
      } else if (uptimeMin > 0) {
        uptimeStr = `${uptimeMin}m ${uptimeSec % 60}s`;
      } else {
        uptimeStr = `${uptimeSec}s`;
      }

      // Check running builds via DB
      let runningCount = 0;
      try {
        const { openDatabase } = await import('../monitor/db.js');
        const dbPath = resolve(cwd, '.eforge', 'monitor.db');
        const db = openDatabase(dbPath);
        runningCount = db.getRunningRuns().length;
        db.close();
      } catch {
        // DB may not exist
      }

      console.log(chalk.bold('Daemon Status'));
      console.log(`  Port:    ${lock.port}`);
      console.log(`  PID:     ${lock.pid}`);
      console.log(`  URL:     http://localhost:${lock.port}`);
      console.log(`  Uptime:  ${uptimeStr}`);
      console.log(`  Builds:  ${runningCount} running`);
    });

  // MCP proxy command — runs the stdio MCP server that bridges to the daemon
  program
    .command('mcp-proxy')
    .description('Run the MCP stdio proxy server (used by Claude Code plugin)')
    .action(async () => {
      const { runMcpProxy } = await import('./mcp-proxy.js');
      await runMcpProxy(process.cwd());
    });

  return program;
}

export async function run(): Promise<void> {
  const abortController = setupSignalHandlers();
  const program = createProgram(abortController);
  await program.parseAsync();
}

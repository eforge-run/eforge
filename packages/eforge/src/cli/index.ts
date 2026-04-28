import { Command } from 'commander';
import chalk from 'chalk';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

declare const EFORGE_VERSION: string;

import { EforgeEngine } from '@eforge-build/engine/eforge';
import { QueueExecExitCode, queueExecExitCode } from '@eforge-build/engine/prd-queue';
import type { EforgeConfig, HookConfig } from '@eforge-build/engine/config';
import type { EforgeEvent } from '@eforge-build/engine/events';
import { withHooks } from '@eforge-build/engine/hooks';
import { withSessionId, withRunId, runSession } from '@eforge-build/engine/session';
import { initDisplay, renderEvent, renderStatus, renderLangfuseStatus, renderQueueList, stopAllSpinners } from './display.js';
import { createClarificationHandler, createApprovalHandler } from './interactive.js';
import { registerDebugComposerCommand } from './debug-composer.js';
import { ensureMonitor, signalMonitorShutdown, type Monitor } from '@eforge-build/monitor';
import { readLockfile, isServerAlive, isPidAlive, killPidIfAlive, lockfilePath, removeLockfile, isAgentWorktreeCwd } from '@eforge-build/client';
import { runOrDelegate } from './run-or-delegate.js';
import { formatCliError } from './errors.js';

const SHUTDOWN_TIMEOUT_MS = 5000;

function buildConfigOverrides(options: { maxConcurrentBuilds?: number; plugins?: boolean }): Partial<EforgeConfig> | undefined {
  const overrides: Partial<EforgeConfig> = {};
  if (options.maxConcurrentBuilds !== undefined) overrides.maxConcurrentBuilds = options.maxConcurrentBuilds;
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
    if (monitor.server.port !== 4567) {
      console.error(chalk.green.bold(`  Monitor: ${monitor.server.url}`));
    } else {
      console.error(chalk.dim(`  Monitor: ${monitor.server.url}`));
    }
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


export function createProgram(abortController?: AbortController): Command {
  const program = new Command();

  program
    .name('eforge')
    .description('Autonomous plan-build-review CLI for code generation')
    .version(EFORGE_VERSION);

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
    .option('--max-concurrent-builds <n>', 'Max parallel queue PRDs', parseInt)
    .option('--dry-run', 'Compile only, then show execution plan without building')
    .option('--foreground', 'Run in-process instead of delegating to daemon')
    .option('--no-cleanup', 'Keep plan files after successful build')
    .option('--no-monitor', 'Disable web monitor')
    .option('--no-plugins', 'Disable plugin loading')
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
          maxConcurrentBuilds?: number;
          dryRun?: boolean;
          foreground?: boolean;
          monitor?: boolean;
          plugins?: boolean;
          watch?: boolean;
          pollInterval?: number;
        },
      ) => {
        // --queue mode: delegate to engine.runQueue() or engine.watchQueue()
        if (options.queue) {
          if (options.watch) process.title = 'eforge-watcher';
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

        // Normal mode: source is required
        if (!source) {
          console.error(chalk.red('Error: <source> is required unless --queue is specified'));
          process.exit(1);
        }

        try {
          const result = await runOrDelegate({ mode: 'build', source, options, abortController, onMonitor: (m) => { activeMonitor = m; } });
          process.exit(result.code);
        } catch (err) {
          const { message, exitCode } = formatCliError(err);
          console.error(chalk.red(`Error: ${message}`));
          process.exit(exitCode);
        }
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
      const { loadQueue, isPrdRunning } = await import('@eforge-build/engine/prd-queue');
      const { loadConfig } = await import('@eforge-build/engine/config');
      const { config, warnings: configWarnings } = await loadConfig();
      for (const warning of configWarnings) {
        process.stderr.write(`${warning}\n`);
      }
      const cwd = process.cwd();
      const queueDir = config.prdQueue.dir;

      // Load PRDs from main queue dir and subdirectories
      const [allPending, failed, skipped] = await Promise.all([
        loadQueue(queueDir, cwd),
        loadQueue(`${queueDir}/failed`, cwd),
        loadQueue(`${queueDir}/skipped`, cwd),
      ]);

      // Split pending into running vs pending by checking lock files
      const pending: typeof allPending = [];
      const running: typeof allPending = [];
      for (const prd of allPending) {
        if (await isPrdRunning(prd.id, cwd)) {
          running.push(prd);
        } else {
          pending.push(prd);
        }
      }

      renderQueueList({ pending, running, failed, skipped });
    });

  queue
    .command('run [name]')
    .description('Process PRDs from the queue')
    .option('--all', 'Process all pending PRDs')
    .option('--auto', 'Run without approval gates')
    .option('--verbose', 'Stream agent output')
    .option('--no-monitor', 'Disable web monitor')
    .option('--no-plugins', 'Disable plugin loading')
    .option('--max-concurrent-builds <n>', 'Max parallel queue PRDs', parseInt)
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
          maxConcurrentBuilds?: number;
          watch?: boolean;
          pollInterval?: number;
        },
      ) => {
        try {
          const result = await runOrDelegate({ mode: 'queue', name, options, abortController, onMonitor: (m) => { activeMonitor = m; } });
          process.exit(result.code);
        } catch (err) {
          const { message, exitCode } = formatCliError(err);
          console.error(chalk.red(`Error: ${message}`));
          process.exit(exitCode);
        }
      },
    );

  queue
    .command('exec <prdId>')
    .description('Build a single PRD directly (subprocess entry point for the queue scheduler)')
    .option('--auto', 'Run without approval gates')
    .option('--verbose', 'Stream agent output')
    .option('--no-monitor', 'Disable web monitor')
    .option('--no-plugins', 'Disable plugin loading')
    .option('--session-id <uuid>', 'Session ID injected by parent scheduler (skips child session:start emission)')
    .action(
      async (
        prdId: string,
        options: {
          auto?: boolean;
          verbose?: boolean;
          monitor?: boolean;
          plugins?: boolean;
          sessionId?: string;
        },
      ) => {
        process.title = `eforge-build:${prdId}`;
        initDisplay({ verbose: options.verbose });

        const configOverrides = buildConfigOverrides(options);

        const engine = await EforgeEngine.create({
          onClarification: createClarificationHandler(options.auto ?? false),
          onApproval: createApprovalHandler(options.auto ?? false),
          ...(configOverrides && { config: configOverrides }),
        });

        const { loadQueue } = await import('@eforge-build/engine/prd-queue');
        const prds = await loadQueue(engine.resolvedConfig.prdQueue.dir, process.cwd());
        const prd = prds.find((p) => p.id === prdId);
        if (!prd) {
          console.error(chalk.red(`PRD not found in queue: ${prdId}`));
          process.exit(QueueExecExitCode.NotFound);
        }

        const exitCode = await withMonitor(options.monitor === false, async (monitor) => {
          const buildEvents = engine.buildSinglePrd(prd, {
            auto: options.auto,
            verbose: options.verbose,
            abortController,
          }, options.sessionId);

          const wrapped = wrapEvents(buildEvents, monitor, engine.resolvedConfig.hooks);

          let completionStatus: 'completed' | 'failed' | 'skipped' | undefined;
          let skipReason: string | undefined;
          for await (const event of wrapped) {
            renderEvent(event);
            // Narrow via event.type rather than raw `as` casts — the
            // EforgeEvent union already carries these fields.
            if (event.type === 'queue:prd:complete') {
              completionStatus = event.status;
            } else if (event.type === 'queue:prd:skip') {
              skipReason = event.reason;
            }
          }

          return queueExecExitCode(completionStatus, skipReason);
        });

        // Exit *after* withMonitor's finally has torn down the monitor /
        // spinners / hooks. Calling process.exit inside the callback would
        // leak the monitor subprocess when --no-monitor is omitted.
        process.exit(exitCode);
      },
    );

  // Config commands
  const config = program
    .command('config')
    .description('Manage eforge configuration');

  config
    .command('validate')
    .description('Validate eforge/config.yaml configuration')
    .action(async () => {
      const { validateConfigFile } = await import('@eforge-build/engine/config');
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
      const { loadConfig } = await import('@eforge-build/engine/config');
      const { stringify } = await import('yaml');
      const { config: resolved, warnings: configWarnings } = await loadConfig();
      for (const warning of configWarnings) {
        process.stderr.write(`${warning}\n`);
      }
      console.log(stringify(resolved));
    });

  // Diagnostic commands
  registerDebugComposerCommand(program);

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
      if (isAgentWorktreeCwd(cwd)) {
        console.error(chalk.red(
          `Refusing to start eforge daemon from agent worktree: ${cwd}. ` +
          `Run eforge from the project root, not from inside a worktree.`,
        ));
        process.exit(2);
      }
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
        // Stale lockfile — kill stale daemon before spawning
        // SIGTERM first
        killPidIfAlive(existingLock.pid);
        // Wait 500ms for graceful shutdown
        await new Promise((r) => setTimeout(r, 500));
        // SIGKILL survivor
        if (isPidAlive(existingLock.pid)) {
          killPidIfAlive(existingLock.pid, 'SIGKILL');
        }
        removeLockfile(cwd);
      }

      // Spawn detached server-main with --persistent flag
      const { fork } = await import('node:child_process');
      const { fileURLToPath } = await import('node:url');

      // Resolve via ESM import.meta.resolve: the monitor package's
      // ./server-main export only declares an "import" condition, so CJS
      // require.resolve (including createRequire) cannot match it.
      let serverMainPath: string;
      try {
        serverMainPath = fileURLToPath(import.meta.resolve('@eforge-build/monitor/server-main'));
      } catch {
        console.error(chalk.red('Monitor server-main entry not found. Did you run `pnpm build`?'));
        process.exit(1);
      }

      // Pass the CLI path through to the daemon so its in-process watcher
      // can spawn `queue exec` children against the CLI (argv[1] in the
      // daemon points at server-main.js, not the CLI).
      const env = { ...process.env };
      if (process.argv[1]) env.EFORGE_CLI_PATH = process.argv[1];

      const child = fork(serverMainPath, [dbPath, String(preferredPort), cwd, '--persistent'], {
        detached: true,
        stdio: 'ignore',
        execArgv: [...process.execArgv, '--disable-warning=ExperimentalWarning'],
        env,
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
    .option('--force', 'Skip active-build safety check')
    .action(async (options: { force?: boolean }) => {
      const cwd = process.cwd();
      const lock = readLockfile(cwd);

      if (!lock) {
        console.log(chalk.yellow('Daemon is not running'));
        process.exit(0);
      }

      if (!isPidAlive(lock.pid)) {
        removeLockfile(cwd);
        console.log(chalk.yellow('Daemon was not running (stale lockfile removed)'));
        process.exit(0);
      }

      // Safety valve: check for active builds unless --force
      if (!options.force) {
        let runningBuilds: { id: string; command: string; status: string }[] = [];
        try {
          const { openDatabase } = await import('@eforge-build/monitor/db');
          const dbPath = resolve(cwd, '.eforge', 'monitor.db');
          const db = openDatabase(dbPath);
          runningBuilds = db.getRunningRuns();
          db.close();
        } catch {
          // DB may not exist — no active builds
        }

        if (runningBuilds.length > 0) {
          // Non-TTY stdin: auto-force to avoid blocking in scripts/daemon
          const isTTY = process.stdin.isTTY === true;
          if (!isTTY) {
            // Auto-force in non-interactive mode
          } else {
            console.log(chalk.yellow(`Active builds (${runningBuilds.length}):`));
            for (const build of runningBuilds) {
              console.log(chalk.yellow(`  - ${build.id} (${build.command})`));
            }
            const readline = await import('node:readline/promises');
            const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
            try {
              const answer = await rl.question(chalk.yellow('Stop daemon with active builds? [y/N] '));
              if (answer.toLowerCase() !== 'y') {
                console.log(chalk.dim('Aborted'));
                process.exit(0);
              }
            } finally {
              rl.close();
            }
          }
        }
      }

      // Send SIGTERM to the daemon; its shutdown handler aborts the in-process
      // watcher and tears down the lockfile.
      try {
        process.kill(lock.pid, 'SIGTERM');
      } catch {
        // Process may have already exited
      }

      // Wait for lockfile removal (daemon's shutdown handler removes it)
      const maxRetries = 20; // 20 * 250ms = 5s
      const retryInterval = 250;

      for (let i = 0; i < maxRetries; i++) {
        await new Promise((r) => setTimeout(r, retryInterval));
        const stillExists = readLockfile(cwd);
        if (!stillExists) {
          console.log(chalk.green('Daemon stopped'));
          process.exit(0);
        }
      }

      // Force-kill escalation after 5s timeout
      console.log(chalk.yellow('Daemon did not shut down gracefully, escalating to SIGKILL...'));
      killPidIfAlive(lock.pid, 'SIGKILL');
      removeLockfile(cwd);
      console.log(chalk.green('Daemon force-stopped'));
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
        const { openDatabase } = await import('@eforge-build/monitor/db');
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

  daemon
    .command('kill')
    .description('Force-kill the daemon (SIGKILL)')
    .action(async () => {
      const cwd = process.cwd();
      const lock = readLockfile(cwd);

      if (!lock) {
        console.log(chalk.yellow('No daemon tracked for this repo'));
        console.log(chalk.dim('Hint: ps aux | grep eforge'));
        process.exit(0);
      }

      const killed: string[] = [];

      // SIGKILL daemon PID — kills the in-process watcher with it
      if (killPidIfAlive(lock.pid, 'SIGKILL')) {
        killed.push(`daemon (PID ${lock.pid})`);
      }

      removeLockfile(cwd);

      if (killed.length > 0) {
        console.log(chalk.green(`Killed: ${killed.join(', ')}`));
      } else {
        console.log(chalk.yellow('No running processes found (lockfile removed)'));
      }
    });

  // --- eforge:region plan-02-cli-and-engine-api ---
  program
    .command('recover <setName> <prdId>')
    .description('Analyse a failed build and write recovery sidecar files')
    .option('--cwd <cwd>', 'Working directory override')
    .option('--verbose', 'Stream agent output')
    .option('--no-monitor', 'Disable web monitor')
    .action(
      async (
        setName: string,
        prdId: string,
        options: {
          cwd?: string;
          verbose?: boolean;
          monitor?: boolean;
        },
      ) => {
        initDisplay({ verbose: options.verbose });

        const cwd = options.cwd ? resolve(options.cwd) : undefined;

        const engine = await EforgeEngine.create({ ...(cwd && { cwd }) });

        try {
          await withMonitor(options.monitor === false, async (monitor) => {
            const sessionId = randomUUID();

            const recoverEvents = engine.recover(setName, prdId, {
              verbose: options.verbose,
              abortController,
              ...(cwd && { cwd }),
            });

            await consumeEvents(
              wrapEvents(runSession(recoverEvents, sessionId), monitor, engine.resolvedConfig.hooks),
            );
          });
        } catch (err) {
          const { message, exitCode } = formatCliError(err);
          console.error(chalk.red(`Error: ${message}`));
          process.exit(exitCode);
        }
      },
    );
  // --- eforge:endregion plan-02-cli-and-engine-api ---

  // --- eforge:region plan-01-backend-apply-recovery ---
  program
    .command('apply-recovery <setName> <prdId>')
    .description('Apply the recovery verdict for a failed build plan (requeue, enqueue successor, or abandon)')
    .option('--cwd <cwd>', 'Working directory override')
    .option('--no-monitor', 'Disable web monitor')
    .action(
      async (
        setName: string,
        prdId: string,
        options: {
          cwd?: string;
          monitor?: boolean;
        },
      ) => {
        initDisplay({});

        const cwd = options.cwd ? resolve(options.cwd) : undefined;

        const engine = await EforgeEngine.create({ ...(cwd && { cwd }) });

        try {
          await withMonitor(options.monitor === false, async (monitor) => {
            const sessionId = randomUUID();

            const applyEvents = engine.applyRecovery(setName, prdId);

            await consumeEvents(
              wrapEvents(runSession(applyEvents, sessionId), monitor, engine.resolvedConfig.hooks),
            );
          });
        } catch (err) {
          const { message, exitCode } = formatCliError(err);
          console.error(chalk.red(`Error: ${message}`));
          process.exit(exitCode);
        }
      },
    );
  // --- eforge:endregion plan-01-backend-apply-recovery ---

  // MCP proxy command — runs the stdio MCP server that bridges to the daemon
  program
    .command('mcp-proxy')
    .description('Run the MCP stdio proxy server (used by Claude Code plugin)')
    .action(async () => {
      process.title = 'eforge-mcp';
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

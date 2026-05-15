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
import { withNativeEventHooks, type NativeExtensionRegistry } from '@eforge-build/engine/extensions/index';
import { initDisplay, renderEvent, renderStatus, renderLangfuseStatus, renderQueueList, stopAllSpinners } from './display.js';
import { registerPlaybookCommand } from './playbook.js';
import { createClarificationHandler, createApprovalHandler } from './interactive.js';
import { registerDebugComposerCommand } from './debug-composer.js';
import { ensureMonitor, signalMonitorShutdown, type Monitor } from '@eforge-build/monitor';
import {
  readLockfile,
  isServerAlive,
  isPidAlive,
  killPidIfAlive,
  lockfilePath,
  removeLockfile,
  isAgentWorktreeCwd,
  apiListExtensions,
  apiShowExtension,
  apiValidateExtensions,
  apiTestExtension,
  apiNewExtension,
  apiReloadExtensions,
  type ExtensionEntry,
  type ExtensionNewRequest,
  type ExtensionTestRequest,
  type ExtensionTestResponse,
} from '@eforge-build/client';
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

/** Exposed for testing only — sets the module-level active monitor. */
export function setActiveMonitor(m: Monitor | undefined): void {
  activeMonitor = m;
}

export function setupSignalHandlers(): AbortController {
  const controller = new AbortController();
  let teardownStarted = false;

  const handleSignal = (exitCode: number) => {
    if (teardownStarted) return;
    teardownStarted = true;
    controller.abort();
    stopAllSpinners();
    const timer = setTimeout(() => process.exit(exitCode), SHUTDOWN_TIMEOUT_MS);
    timer.unref();
    if (activeMonitor) {
      try { activeMonitor.stop(); } catch {}
      activeMonitor = undefined;
    }
  };

  const handleException = (exitCode: number, err: unknown) => {
    process.stderr.write(`[eforge] unhandled error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    handleSignal(exitCode);
  };

  process.on('SIGINT', () => handleSignal(130));
  process.on('SIGTERM', () => handleSignal(130));
  process.on('SIGHUP', () => handleSignal(130));
  process.on('uncaughtException', (err) => handleException(1, err));
  process.on('unhandledRejection', (reason) => handleException(1, reason));

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

interface WrapEventsOptions {
  monitor: Monitor;
  hooks: readonly HookConfig[];
  native: {
    registry: Pick<NativeExtensionRegistry, 'eventHooks'>;
    timeoutMs: number;
    cwd?: string;
  };
  sessionOpts?: import('@eforge-build/engine/session').SessionOptions;
}

function wrapEvents(
  events: AsyncGenerator<EforgeEvent>,
  opts: WrapEventsOptions,
): AsyncGenerator<EforgeEvent> {
  let wrapped = opts.sessionOpts ? withSessionId(events, opts.sessionOpts) : events;
  wrapped = withRunId(wrapped);
  wrapped = withNativeEventHooks(wrapped, opts.native.registry, {
    cwd: opts.native.cwd ?? process.cwd(),
    timeoutMs: opts.native.timeoutMs,
  });
  wrapped = opts.monitor.wrapEvents(wrapped);
  return opts.hooks.length > 0 ? withHooks(wrapped, opts.hooks, process.cwd()) : wrapped;
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

// --- eforge:region plan-02-extension-tooling-surfaces ---
function extensionRegistrationSummary(entry: ExtensionEntry): string {
  const parts = Object.entries(entry.registrations)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `${kind}:${count}`);
  return parts.length > 0 ? parts.join(',') : '-';
}

function renderExtensionTable(extensions: ExtensionEntry[]): void {
  if (extensions.length === 0) {
    console.log(chalk.dim('No extensions found'));
    return;
  }
  const rows = extensions.map((entry) => ({
    name: entry.name,
    status: entry.status,
    scope: entry.scope,
    source: entry.source,
    enabled: String(entry.enabled),
    registrations: extensionRegistrationSummary(entry),
    path: entry.path,
  }));
  const headers = ['name', 'status', 'enabled', 'scope', 'source', 'registrations', 'path'] as const;
  const widths = Object.fromEntries(headers.map((header) => [
    header,
    Math.max(header.length, ...rows.map((row) => String(row[header]).length)),
  ])) as Record<typeof headers[number], number>;
  console.log(headers.map((header) => header.padEnd(widths[header])).join('  '));
  console.log(headers.map((header) => '-'.repeat(widths[header])).join('  '));
  for (const row of rows) {
    console.log(headers.map((header) => String(row[header]).padEnd(widths[header])).join('  '));
  }
}

function renderExtensionDetail(entry: ExtensionEntry): void {
  console.log(chalk.bold(entry.name));
  console.log(`  Status:        ${entry.status}`);
  console.log(`  Enabled:       ${entry.enabled}`);
  console.log(`  Scope:         ${entry.scope}`);
  console.log(`  Source:        ${entry.source}`);
  console.log(`  Path:          ${entry.path}`);
  if (entry.entrypoint) console.log(`  Entrypoint:    ${entry.entrypoint}`);
  if (entry.strategy) console.log(`  Strategy:      ${entry.strategy}`);
  console.log(`  Registrations: ${extensionRegistrationSummary(entry)}`);
  if (entry.shadows.length > 0) {
    console.log('  Shadows:');
    for (const shadow of entry.shadows) {
      console.log(`    - ${shadow.scope}: ${shadow.path}`);
    }
  }
  if (entry.diagnostics.length > 0) {
    console.log('  Diagnostics:');
    for (const diagnostic of entry.diagnostics) {
      const color = diagnostic.severity === 'error' ? chalk.red : chalk.yellow;
      console.log(color(`    - ${diagnostic.code}: ${diagnostic.message}`));
    }
  }
}

function formatExtensionTestSource(source: ExtensionTestResponse['source']): string {
  const parts: string[] = [source.kind];
  if (source.fixture) parts.push(source.fixture);
  if (source.run) parts.push(`run=${source.run}`);
  if (source.sessionId) parts.push(`session=${source.sessionId}`);
  if (source.event) parts.push(`event=${source.event}`);
  return parts.join(' ');
}

function renderExtensionTestResult(data: ExtensionTestResponse): void {
  if (data.valid) {
    console.log(chalk.green('✔') + ' Extensions test passed');
  } else {
    console.error(chalk.red('✘') + ' Extensions test failed');
  }

  console.log(`  Source:                ${formatExtensionTestSource(data.source)}`);
  console.log(`  Extensions:            ${data.extensions.length}`);
  console.log(`  Replayed events:       ${data.replay.inputEventCount}`);
  console.log(`  Filtered events:       ${data.replay.filteredEventCount}`);
  console.log(`  Emitted events:        ${data.replay.emittedEventCount}`);
  console.log(`  Matches:               ${data.matches.length}`);
  console.log(`  Emitted diagnostics:   ${data.emittedDiagnostics.length}`);

  if (data.matches.length === 0) {
    console.log(chalk.dim('  No event hooks matched the replay input.'));
  } else {
    console.log('  Matched event hooks:');
    for (const match of data.matches) {
      console.log(`    - event[${match.eventIndex}] ${match.eventType} -> ${match.extensionName} (${match.pattern})`);
    }
  }

  if (data.deferredRegistrations.length > 0) {
    console.log('  Deferred registrations:');
    for (const entry of data.deferredRegistrations) {
      console.log(`    - ${entry.family}: ${entry.count}`);
    }
  } else {
    console.log('  Deferred registrations: none');
  }

  if (data.diagnostics.length > 0) {
    console.log('  Diagnostics:');
    for (const diagnostic of data.diagnostics) {
      const color = diagnostic.severity === 'error' ? chalk.red : chalk.yellow;
      const target = diagnostic.name ?? diagnostic.path;
      console.log(color(`    - ${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}${target ? ` (${target})` : ''}`));
    }
  }

  if (data.emittedDiagnostics.length > 0) {
    console.log('  Emitted diagnostic details:');
    for (const diagnostic of data.emittedDiagnostics) {
      const timeout = 'timeoutMs' in diagnostic ? ` timeoutMs=${diagnostic.timeoutMs}` : '';
      const message = 'message' in diagnostic ? `: ${diagnostic.message}` : '';
      console.log(chalk.red(`    - ${diagnostic.type}: ${diagnostic.extensionName} ${diagnostic.pattern} on ${diagnostic.triggeringEventType}${message}${timeout}`));
    }
  }
}

function isExtensionPathArg(value: string): boolean {
  return /[\\/]/.test(value) || /\.(?:mjs|mts|js|ts)$/.test(value);
}
// --- eforge:endregion plan-02-extension-tooling-surfaces ---

export function createProgram(abortController?: AbortController, version?: string): Command {
  const program = new Command();

  program
    .name('eforge')
    .description('Autonomous plan-build-review CLI for code generation')
    .version(version ?? EFORGE_VERSION);

  program
    .command('enqueue <source>')
    .description('Normalize input and add it to the PRD queue')
    .option('--name <name>', 'Override the inferred PRD title')
    .option('--verbose', 'Stream agent output')
    .option('--no-plugins', 'Disable plugin loading')
    .option('--profile <name>', 'Override active profile for this enqueue + build')
    .action(
      async (
        source: string,
        options: {
          name?: string;
          verbose?: boolean;
          plugins?: boolean;
          profile?: string;
        },
      ) => {
        initDisplay({ verbose: options.verbose });

        const configOverrides = buildConfigOverrides(options);

        const engine = await EforgeEngine.create({
          ...(configOverrides && { config: configOverrides }),
          ...(options.profile && { profileOverride: options.profile }),
        });

        await withMonitor(true /* noServer */, async (monitor) => {
          const sessionId = randomUUID();

          const enqueueEvents = engine.enqueue(source, {
            name: options.name,
            verbose: options.verbose,
            abortController,
            ...(options.profile && { profile: options.profile }),
          });

          await consumeEvents(
            wrapEvents(runSession(enqueueEvents, sessionId), {
              monitor,
              hooks: engine.resolvedConfig.hooks,
              native: {
                registry: engine.nativeExtensionRegistry,
                timeoutMs: engine.resolvedConfig.extensions.eventHookTimeoutMs,
              },
            }),
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
              wrapEvents(queueEvents, {
                monitor,
                hooks: engine.resolvedConfig.hooks,
                native: {
                  registry: engine.nativeExtensionRegistry,
                  timeoutMs: engine.resolvedConfig.extensions.eventHookTimeoutMs,
                },
              }),
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
      // --- eforge:region plan-05-piggyback-and-queue-scheduling ---
      const [allPending, failed, skipped, waiting] = await Promise.all([
        loadQueue(queueDir, cwd),
        loadQueue(`${queueDir}/failed`, cwd),
        loadQueue(`${queueDir}/skipped`, cwd),
        loadQueue(`${queueDir}/waiting`, cwd).catch(() => [] as Awaited<ReturnType<typeof loadQueue>>),
      ]);
      // --- eforge:endregion plan-05-piggyback-and-queue-scheduling ---

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

      // --- eforge:region plan-05-piggyback-and-queue-scheduling ---
      renderQueueList({ pending, running, failed, skipped, waiting });
      // --- eforge:endregion plan-05-piggyback-and-queue-scheduling ---
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
    .option('--profile <name>', 'Override active profile for this build')
    .action(
      async (
        prdId: string,
        options: {
          auto?: boolean;
          verbose?: boolean;
          monitor?: boolean;
          plugins?: boolean;
          sessionId?: string;
          profile?: string;
        },
      ) => {
        process.title = `eforge-build:${prdId}`;
        initDisplay({ verbose: options.verbose });

        const configOverrides = buildConfigOverrides(options);

        const engine = await EforgeEngine.create({
          onClarification: createClarificationHandler(options.auto ?? false),
          onApproval: createApprovalHandler(options.auto ?? false),
          ...(configOverrides && { config: configOverrides }),
          ...(options.profile && { profileOverride: options.profile }),
        }).catch((err: unknown) => {
          console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
          process.exit(QueueExecExitCode.Failed);
        }) as EforgeEngine;

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

          const wrapped = wrapEvents(buildEvents, {
            monitor,
            hooks: engine.resolvedConfig.hooks,
            native: {
              registry: engine.nativeExtensionRegistry,
              timeoutMs: engine.resolvedConfig.extensions.eventHookTimeoutMs,
            },
          });

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

  // --- eforge:region plan-02-extension-tooling-surfaces ---
  const extension = program
    .command('extension')
    .description('Manage native eforge extensions');

  extension
    .command('list')
    .description('List discovered native extensions')
    .option('--json', 'Output JSON')
    .action(async (options: { json?: boolean }) => {
      try {
        const { data } = await apiListExtensions({ cwd: process.cwd() });
        if (options.json) {
          console.log(JSON.stringify(data, null, 2));
        } else {
          renderExtensionTable(data.extensions);
          for (const diagnostic of data.diagnostics) {
            const color = diagnostic.severity === 'error' ? chalk.red : chalk.yellow;
            process.stderr.write(color(`${diagnostic.code}: ${diagnostic.message}\n`));
          }
        }
      } catch (err) {
        const { message, exitCode } = formatCliError(err);
        console.error(chalk.red(`Error: ${message}`));
        process.exit(exitCode);
      }
    });

  extension
    .command('show <name>')
    .description('Show one native extension by name')
    .option('--json', 'Output JSON')
    .action(async (name: string, options: { json?: boolean }) => {
      try {
        const { data } = await apiShowExtension({ cwd: process.cwd(), name });
        if (options.json) {
          console.log(JSON.stringify(data, null, 2));
        } else {
          renderExtensionDetail(data.extension);
        }
      } catch (err) {
        const { message, exitCode } = formatCliError(err);
        console.error(chalk.red(`Error: ${message}`));
        process.exit(exitCode);
      }
    });

  extension
    .command('validate [nameOrPath]')
    .description('Validate configured native extensions, or a single extension name/path')
    .option('--json', 'Output JSON')
    .action(async (nameOrPath: string | undefined, options: { json?: boolean }) => {
      try {
        const request = nameOrPath
          ? isExtensionPathArg(nameOrPath)
            ? { cwd: process.cwd(), path: nameOrPath }
            : { cwd: process.cwd(), name: nameOrPath }
          : { cwd: process.cwd() };
        const { data } = await apiValidateExtensions(request);
        if (options.json) {
          console.log(JSON.stringify(data, null, 2));
        } else if (data.valid) {
          console.log(chalk.green('✔') + ' Extensions valid');
        } else {
          console.error(chalk.red('✘') + ' Extensions invalid:');
          for (const diagnostic of data.diagnostics) {
            console.error(chalk.red(`  - ${diagnostic.code}: ${diagnostic.message}`));
          }
        }
        if (!data.valid) process.exit(1);
      } catch (err) {
        const { message, exitCode } = formatCliError(err);
        console.error(chalk.red(`Error: ${message}`));
        process.exit(exitCode);
      }
    });

  extension
    .command('test [nameOrPath]')
    .description('Dry-run native extension event hooks against fixture or monitor events')
    .option('--run <run>', 'Replay monitor DB events: latest or a session/run id')
    .option('--event <type>', 'Filter replay input by exact event type')
    .option('--fixture <path>', 'Replay project-local fixture events from a JSON or JSONL file')
    .option('--json', 'Output JSON')
    .action(async (nameOrPath: string | undefined, options: { run?: string; event?: string; fixture?: string; json?: boolean }) => {
      try {
        const body: ExtensionTestRequest = {};
        if (nameOrPath) {
          if (isExtensionPathArg(nameOrPath)) body.path = nameOrPath;
          else body.name = nameOrPath;
        }
        if (options.fixture !== undefined) body.fixture = options.fixture;
        if (options.run !== undefined) body.run = options.run;
        if (options.event !== undefined) body.event = options.event;
        const { data } = await apiTestExtension({ cwd: process.cwd(), body });
        if (options.json) {
          console.log(JSON.stringify(data, null, 2));
        } else {
          renderExtensionTestResult(data);
        }
        if (!data.valid) process.exit(1);
      } catch (err) {
        const { message, exitCode } = formatCliError(err);
        console.error(chalk.red(`Error: ${message}`));
        process.exit(exitCode);
      }
    });

  extension
    .command('new <name>')
    .description('Scaffold a native eforge extension')
    .option('--scope <scope>', 'Extension scope: local, project, or user')
    .option('--template <template>', 'Scaffold template')
    .option('--force', 'Overwrite an existing extension file')
    .option('--json', 'Output JSON')
    .action(async (name: string, options: { scope?: string; template?: string; force?: boolean; json?: boolean }) => {
      try {
        const body: ExtensionNewRequest = { name };
        if (options.scope !== undefined) {
          if (!['local', 'project', 'user'].includes(options.scope)) {
            throw new Error('--scope must be one of: local, project, user');
          }
          body.scope = options.scope as ExtensionNewRequest['scope'];
        }
        if (options.template !== undefined) body.template = options.template as ExtensionNewRequest['template'];
        if (options.force !== undefined) body.force = options.force;
        const { data } = await apiNewExtension({ cwd: process.cwd(), body });
        if (options.json) {
          console.log(JSON.stringify(data, null, 2));
        } else {
          console.log(chalk.green('✔') + ` Extension ${data.name} scaffolded`);
          console.log(`  Path:       ${data.path}`);
          console.log(`  Scope:      ${data.scope}`);
          console.log(`  Template:   ${data.template}`);
          console.log(`  Overwritten:${data.overwritten ? ' yes' : ' no'}`);
          console.log(chalk.dim(`Next: eforge extension validate ${data.name}`));
          console.log(chalk.dim('Next: eforge extension reload'));
        }
      } catch (err) {
        const { message, exitCode } = formatCliError(err);
        console.error(chalk.red(`Error: ${message}`));
        process.exit(exitCode);
      }
    });

  extension
    .command('reload')
    .description('Reload native extension discovery and restart the daemon watcher when running')
    .option('--json', 'Output JSON')
    .action(async (options: { json?: boolean }) => {
      try {
        const { data } = await apiReloadExtensions({ cwd: process.cwd() });
        if (options.json) {
          console.log(JSON.stringify(data, null, 2));
        } else {
          console.log(chalk.green('✔') + ' Extensions reloaded');
          console.log(`  Watcher was running: ${data.watcher.wasRunning}`);
          console.log(`  Watcher restarted:   ${data.watcher.restarted}`);
          console.log(`  Watcher running:     ${data.watcher.running}`);
          console.log(`  Diagnostics:         ${data.diagnostics.length}`);
          console.log(`  Message:             ${data.watcher.message}`);
        }
      } catch (err) {
        const { message, exitCode } = formatCliError(err);
        console.error(chalk.red(`Error: ${message}`));
        process.exit(exitCode);
      }
    });
  // --- eforge:endregion plan-02-extension-tooling-surfaces ---

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
              wrapEvents(runSession(recoverEvents, sessionId), {
                monitor,
                hooks: engine.resolvedConfig.hooks,
                native: {
                  registry: engine.nativeExtensionRegistry,
                  timeoutMs: engine.resolvedConfig.extensions.eventHookTimeoutMs,
                  ...(cwd && { cwd }),
                },
              }),
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
    .command('apply-recovery <prdId>')
    .description('Apply the recovery verdict for a failed build plan (requeue, enqueue successor, or abandon)')
    .option('--cwd <cwd>', 'Working directory override')
    .option('--no-monitor', 'Disable web monitor')
    .action(
      async (
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

            const applyEvents = engine.applyRecovery(prdId);

            await consumeEvents(
              wrapEvents(runSession(applyEvents, sessionId), {
                monitor,
                hooks: engine.resolvedConfig.hooks,
                native: {
                  registry: engine.nativeExtensionRegistry,
                  timeoutMs: engine.resolvedConfig.extensions.eventHookTimeoutMs,
                  ...(cwd && { cwd }),
                },
              }),
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

  // --- eforge:region plan-03-cli-playbook-commands ---
  registerPlaybookCommand(program);
  // --- eforge:endregion plan-03-cli-playbook-commands ---

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

/**
 * Factory function for the eforge Commander program tree.
 * Exported for programmatic use (docs-gen, testing) — builds the full command
 * hierarchy without executing or parsing args. An optional `version` override
 * can be supplied when the caller does not have access to the baked-in
 * EFORGE_VERSION define constant.
 */
export function buildEforgeCommand(options?: { version?: string }): Command {
  return createProgram(undefined, options?.version);
}

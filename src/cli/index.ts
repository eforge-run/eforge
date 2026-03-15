import { Command } from 'commander';
import chalk from 'chalk';
import { resolve } from 'node:path';

import { EforgeEngine } from '../engine/eforge.js';
import {
  validatePlanSet,
  parseOrchestrationConfig,
  resolveDependencyGraph,
  validateRuntimeReadiness,
} from '../engine/plan.js';
import type { EforgeConfig, HookConfig } from '../engine/config.js';
import type { EforgeEvent, PlanFile } from '../engine/events.js';
import { withHooks } from '../engine/hooks.js';
import { initDisplay, renderEvent, renderStatus, renderDryRun, renderLangfuseStatus, stopAllSpinners } from './display.js';
import { createClarificationHandler, createApprovalHandler } from './interactive.js';
import { ensureMonitor, type Monitor } from '../monitor/index.js';
import { readLockfile, isServerAlive } from '../monitor/lockfile.js';

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
  noMonitor: boolean | undefined,
  fn: (monitor: Monitor | undefined) => Promise<T>,
): Promise<T> {
  if (noMonitor) {
    return fn(undefined);
  }

  const monitor = await ensureMonitor(process.cwd());
  activeMonitor = monitor;
  console.error(chalk.dim(`  Monitor: ${monitor.server.url}`));

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
  monitor: Monitor | undefined,
  hooks: readonly HookConfig[],
): AsyncGenerator<EforgeEvent> {
  let wrapped = events;
  if (hooks.length > 0) {
    wrapped = withHooks(wrapped, hooks, process.cwd());
  }
  return monitor ? monitor.wrapEvents(wrapped) : wrapped;
}

async function consumeEvents(
  events: AsyncGenerator<EforgeEvent>,
  opts?: { afterStart?: () => void },
): Promise<'completed' | 'failed'> {
  let result: 'completed' | 'failed' = 'completed';
  for await (const event of events) {
    renderEvent(event);
    if (event.type === 'eforge:start' && opts?.afterStart) {
      opts.afterStart();
    }
    if (event.type === 'eforge:end') {
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
    .command('plan <source>')
    .description('Generate execution plans from a PRD file or description')
    .option('--auto', 'Run without approval gates')
    .option('--verbose', 'Stream agent output')
    .option('--name <name>', 'Plan set name (inferred from source if omitted)')
    .option('--no-monitor', 'Disable web monitor')
    .option('--no-plugins', 'Disable plugin loading')
    .action(
      async (source: string, options: { auto?: boolean; verbose?: boolean; name?: string; monitor?: boolean; plugins?: boolean }) => {
        initDisplay({ verbose: options.verbose });

        const engine = await EforgeEngine.create({
          onClarification: createClarificationHandler(options.auto ?? false),
          onApproval: createApprovalHandler(options.auto ?? false),
          ...(options.plugins === false && { config: { plugins: { enabled: false } } }),
        });

        await withMonitor(options.monitor === false, async (monitor) => {
          const result = await consumeEvents(
            wrapEvents(engine.plan(source, {
              auto: options.auto,
              verbose: options.verbose,
              name: options.name,
              abortController,
            }), monitor, engine.resolvedConfig.hooks),
            { afterStart: () => renderLangfuseStatus(engine.resolvedConfig) },
          );

          process.exit(result === 'completed' ? 0 : 1);
        });
      },
    );

  program
    .command('run <source>')
    .description('Plan + build + validate in one step')
    .option('--auto', 'Run without approval gates')
    .option('--verbose', 'Stream agent output')
    .option('--name <name>', 'Plan set name (inferred from source if omitted)')
    .option('--parallelism <n>', 'Max parallel plans', parseInt)
    .option('--dry-run', 'Plan only, then show execution plan without building')
    .option('--no-monitor', 'Disable web monitor')
    .option('--no-plugins', 'Disable plugin loading')
    .action(
      async (
        source: string,
        options: {
          auto?: boolean;
          verbose?: boolean;
          name?: string;
          parallelism?: number;
          dryRun?: boolean;
          monitor?: boolean;
          plugins?: boolean;
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
          // Phase 1: Plan
          let planSetName: string | undefined;
          let planFiles: PlanFile[] = [];
          let planResult: 'completed' | 'failed' = 'completed';

          for await (const event of wrapEvents(engine.plan(source, {
            auto: options.auto,
            verbose: options.verbose,
            name: options.name,
            abortController,
          }), monitor, engine.resolvedConfig.hooks)) {
            renderEvent(event);
            if (event.type === 'eforge:start') {
              renderLangfuseStatus(engine.resolvedConfig);
              planSetName = event.planSet;
            }
            if (event.type === 'plan:complete') {
              planFiles = event.plans;
            }
            if (event.type === 'eforge:end') {
              planResult = event.result.status;
            }
          }

          if (planResult === 'failed' || planFiles.length === 0 || !planSetName) {
            process.exit(1);
          }

          // Handle --dry-run: show execution plan and exit
          if (options.dryRun) {
            await showDryRun(planSetName);
          }

          // Phase 2: Build
          const buildResult = await consumeEvents(
            wrapEvents(engine.build(planSetName, {
              auto: options.auto,
              verbose: options.verbose,
              abortController,
            }), monitor, engine.resolvedConfig.hooks),
            { afterStart: () => renderLangfuseStatus(engine.resolvedConfig) },
          );

          process.exit(buildResult === 'completed' ? 0 : 1);
        });
      },
    );

  program
    .command('build <planSet>')
    .description('Execute plans (implement + review + validate)')
    .option('--auto', 'Run without approval gates')
    .option('--verbose', 'Stream agent output')
    .option('--dry-run', 'Validate and show execution plan without running')
    .option('--parallelism <n>', 'Max parallel plans', parseInt)
    .option('--no-monitor', 'Disable web monitor')
    .option('--no-plugins', 'Disable plugin loading')
    .action(
      async (
        planSet: string,
        options: { auto?: boolean; verbose?: boolean; dryRun?: boolean; parallelism?: number; monitor?: boolean; plugins?: boolean },
      ) => {
        initDisplay({ verbose: options.verbose });

        if (options.dryRun) {
          await showDryRun(planSet);
        }

        const configOverrides = buildConfigOverrides(options);

        const engine = await EforgeEngine.create({
          onClarification: createClarificationHandler(options.auto ?? false),
          onApproval: createApprovalHandler(options.auto ?? false),
          ...(configOverrides && { config: configOverrides }),
        });

        await withMonitor(options.monitor === false, async (monitor) => {
          const result = await consumeEvents(
            wrapEvents(engine.build(planSet, {
              auto: options.auto,
              verbose: options.verbose,
              abortController,
            }), monitor, engine.resolvedConfig.hooks),
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
      const monitor = await ensureMonitor(cwd, options.port);

      console.log(chalk.bold(`Monitor: ${monitor.server.url}`));
      console.log(chalk.dim('Press Ctrl+C to exit'));

      // Keep process alive until Ctrl+C
      await new Promise<void>((resolveWait) => {
        const handler = async () => {
          process.removeListener('SIGINT', handler);
          process.removeListener('SIGTERM', handler);

          monitor.stop();

          // If no active runs remain, signal the detached server to shut down
          try {
            const lock = readLockfile(cwd);
            if (lock) {
              const alive = await isServerAlive(lock);
              if (alive) {
                // Check if there are running runs by re-opening DB briefly
                const { openDatabase } = await import('../monitor/db.js');
                const { resolve: pathResolve } = await import('node:path');
                const dbPath = pathResolve(cwd, '.eforge', 'monitor.db');
                let hasRunning = false;
                try {
                  const checkDb = openDatabase(dbPath);
                  hasRunning = checkDb.getRunningRuns().length > 0;
                  checkDb.close();
                } catch {}

                if (!hasRunning) {
                  // Send SIGTERM to the detached server
                  try {
                    process.kill(lock.pid, 'SIGTERM');
                  } catch {}
                }
              }
            }
          } catch {}

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

  return program;
}

export async function run(): Promise<void> {
  const abortController = setupSignalHandlers();
  const program = createProgram(abortController);
  await program.parseAsync();
}

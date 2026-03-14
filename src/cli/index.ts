import { Command } from 'commander';
import chalk from 'chalk';
import { resolve } from 'node:path';

import { ForgeEngine } from '../engine/forge.js';
import {
  validatePlanSet,
  parseOrchestrationConfig,
  resolveDependencyGraph,
  validateRuntimeReadiness,
} from '../engine/plan.js';
import type { ForgeEvent, PlanFile } from '../engine/events.js';
import { initDisplay, renderEvent, renderStatus, renderDryRun, renderLangfuseStatus, stopAllSpinners } from './display.js';
import { createClarificationHandler, createApprovalHandler, confirmBuild } from './interactive.js';
import { createMonitor, type Monitor } from '../monitor/index.js';

const SHUTDOWN_TIMEOUT_MS = 5000;

let activeMonitor: Monitor | undefined;

function setupSignalHandlers(): AbortController {
  const controller = new AbortController();
  const handler = () => {
    controller.abort();
    stopAllSpinners();
    const timer = setTimeout(() => process.exit(130), SHUTDOWN_TIMEOUT_MS);
    timer.unref();
    if (activeMonitor) {
      activeMonitor.stop().catch(() => {}).finally(() => {
        activeMonitor = undefined;
      });
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

  const monitor = await createMonitor(process.cwd());
  activeMonitor = monitor;
  console.error(chalk.dim(`  Monitor: ${monitor.server.url}`));

  try {
    return await fn(monitor);
  } finally {
    if (activeMonitor) {
      await monitor.stop();
      activeMonitor = undefined;
    }
  }
}

function wrapEvents(
  events: AsyncGenerator<ForgeEvent>,
  monitor: Monitor | undefined,
): AsyncGenerator<ForgeEvent> {
  return monitor ? monitor.wrapEvents(events) : events;
}

async function consumeEvents(
  events: AsyncGenerator<ForgeEvent>,
  opts?: { afterStart?: () => void },
): Promise<'completed' | 'failed'> {
  let result: 'completed' | 'failed' = 'completed';
  for await (const event of events) {
    renderEvent(event);
    if (event.type === 'forge:start' && opts?.afterStart) {
      opts.afterStart();
    }
    if (event.type === 'forge:end') {
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
    .name('aroh-forge')
    .description('Autonomous plan-build-review CLI for code generation')
    .version('0.1.0');

  program
    .command('plan <source>')
    .description('Generate execution plans from a PRD file or description')
    .option('--auto', 'Run without approval gates')
    .option('--verbose', 'Stream agent output')
    .option('--name <name>', 'Plan set name (inferred from source if omitted)')
    .option('--no-monitor', 'Disable web monitor')
    .action(
      async (source: string, options: { auto?: boolean; verbose?: boolean; name?: string; monitor?: boolean }) => {
        initDisplay({ verbose: options.verbose });

        const engine = await ForgeEngine.create({
          onClarification: createClarificationHandler(options.auto ?? false),
          onApproval: createApprovalHandler(options.auto ?? false),
        });

        await withMonitor(options.monitor === false, async (monitor) => {
          const result = await consumeEvents(
            wrapEvents(engine.plan(source, {
              auto: options.auto,
              verbose: options.verbose,
              name: options.name,
              abortController,
            }), monitor),
            { afterStart: () => renderLangfuseStatus(engine.resolvedConfig) },
          );

          process.exit(result === 'completed' ? 0 : 1);
        });
      },
    );

  program
    .command('forge <source>')
    .description('Plan and build in one step')
    .option('--auto', 'Run without approval gates')
    .option('--verbose', 'Stream agent output')
    .option('--name <name>', 'Plan set name (inferred from source if omitted)')
    .option('--parallelism <n>', 'Max parallel plans', parseInt)
    .option('--dry-run', 'Plan only, then show execution plan without building')
    .option('--no-monitor', 'Disable web monitor')
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
        },
      ) => {
        initDisplay({ verbose: options.verbose });

        const configOverrides = options.parallelism
          ? { build: { parallelism: options.parallelism } }
          : undefined;

        const engine = await ForgeEngine.create({
          onClarification: createClarificationHandler(options.auto ?? false),
          onApproval: createApprovalHandler(options.auto ?? false),
          config: configOverrides,
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
          }), monitor)) {
            renderEvent(event);
            if (event.type === 'forge:start') {
              renderLangfuseStatus(engine.resolvedConfig);
              planSetName = event.planSet;
            }
            if (event.type === 'plan:complete') {
              planFiles = event.plans;
            }
            if (event.type === 'forge:end') {
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

          // Approval gate: confirm before building
          if (!options.auto) {
            const approved = await confirmBuild(planFiles);
            if (!approved) {
              console.log('\nBuild skipped.');
              process.exit(0);
            }
          }

          // Phase 2: Build
          const buildResult = await consumeEvents(
            wrapEvents(engine.build(planSetName, {
              auto: options.auto,
              verbose: options.verbose,
              abortController,
            }), monitor),
            { afterStart: () => renderLangfuseStatus(engine.resolvedConfig) },
          );

          process.exit(buildResult === 'completed' ? 0 : 1);
        });
      },
    );

  program
    .command('build <planSet>')
    .description('Execute plans (implement + review)')
    .option('--auto', 'Run without approval gates')
    .option('--verbose', 'Stream agent output')
    .option('--dry-run', 'Validate and show execution plan without running')
    .option('--parallelism <n>', 'Max parallel plans', parseInt)
    .option('--no-monitor', 'Disable web monitor')
    .action(
      async (
        planSet: string,
        options: { auto?: boolean; verbose?: boolean; dryRun?: boolean; parallelism?: number; monitor?: boolean },
      ) => {
        initDisplay({ verbose: options.verbose });

        if (options.dryRun) {
          await showDryRun(planSet);
        }

        const configOverrides = options.parallelism
          ? { build: { parallelism: options.parallelism } }
          : undefined;

        const engine = await ForgeEngine.create({
          onClarification: createClarificationHandler(options.auto ?? false),
          onApproval: createApprovalHandler(options.auto ?? false),
          config: configOverrides,
        });

        await withMonitor(options.monitor === false, async (monitor) => {
          const result = await consumeEvents(
            wrapEvents(engine.build(planSet, {
              auto: options.auto,
              verbose: options.verbose,
              abortController,
            }), monitor),
            { afterStart: () => renderLangfuseStatus(engine.resolvedConfig) },
          );

          process.exit(result === 'completed' ? 0 : 1);
        });
      },
    );

  program
    .command('review <planSet>')
    .description('Review existing code against plans')
    .option('--auto', 'Run without approval gates')
    .option('--verbose', 'Stream agent output')
    .option('--no-monitor', 'Disable web monitor')
    .action(async (planSet: string, options: { auto?: boolean; verbose?: boolean; monitor?: boolean }) => {
      initDisplay({ verbose: options.verbose });

      const engine = await ForgeEngine.create({
        onClarification: createClarificationHandler(options.auto ?? false),
        onApproval: createApprovalHandler(options.auto ?? false),
      });

      await withMonitor(options.monitor === false, async (monitor) => {
        const result = await consumeEvents(
          wrapEvents(engine.review(planSet, {
            auto: options.auto,
            verbose: options.verbose,
            abortController,
          }), monitor),
          { afterStart: () => renderLangfuseStatus(engine.resolvedConfig) },
        );

        process.exit(result === 'completed' ? 0 : 1);
      });
    });

  program
    .command('status')
    .description('Check running builds')
    .action(async () => {
      const engine = await ForgeEngine.create();
      renderStatus(engine.status());
    });

  return program;
}

export async function run(): Promise<void> {
  const abortController = setupSignalHandlers();
  const program = createProgram(abortController);
  await program.parseAsync();
}

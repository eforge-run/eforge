import { Command } from 'commander';
import { resolve } from 'node:path';

import { ForgeEngine } from '../engine/forge.js';
import {
  validatePlanSet,
  parseOrchestrationConfig,
  resolveDependencyGraph,
} from '../engine/plan.js';
import type { ForgeEvent, PlanFile } from '../engine/events.js';
import { initDisplay, renderEvent, renderStatus, renderDryRun, renderLangfuseStatus, stopAllSpinners } from './display.js';
import { createClarificationHandler, createApprovalHandler, confirmBuild } from './interactive.js';

const SHUTDOWN_TIMEOUT_MS = 5000;

function setupSignalHandlers(): void {
  const handler = () => {
    stopAllSpinners();
    const timer = setTimeout(() => process.exit(130), SHUTDOWN_TIMEOUT_MS);
    timer.unref();
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
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
  const configPath = resolve(process.cwd(), 'plans', planSet, 'orchestration.yaml');
  const validation = await validatePlanSet(configPath);
  if (!validation.valid) {
    console.error(
      `Validation failed:\n${validation.errors.map((e) => `  - ${e}`).join('\n')}`,
    );
    process.exit(1);
  }
  const config = await parseOrchestrationConfig(configPath);
  const { waves, mergeOrder } = resolveDependencyGraph(config.plans);
  renderDryRun(config, waves, mergeOrder);
  process.exit(0);
}

export function createProgram(): Command {
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
    .action(
      async (source: string, options: { auto?: boolean; verbose?: boolean; name?: string }) => {
        initDisplay({ verbose: options.verbose });

        const engine = await ForgeEngine.create({
          onClarification: createClarificationHandler(options.auto ?? false),
          onApproval: createApprovalHandler(options.auto ?? false),
        });
        const result = await consumeEvents(
          engine.plan(source, {
            auto: options.auto,
            verbose: options.verbose,
            name: options.name,
          }),
          { afterStart: () => renderLangfuseStatus(engine.resolvedConfig) },
        );

        process.exit(result === 'completed' ? 0 : 1);
      },
    );

  program
    .command('run <source>')
    .description('Plan and build in one step')
    .option('--auto', 'Run without approval gates')
    .option('--verbose', 'Stream agent output')
    .option('--name <name>', 'Plan set name (inferred from source if omitted)')
    .option('--parallelism <n>', 'Max parallel plans', parseInt)
    .option('--dry-run', 'Plan only, then show execution plan without building')
    .action(
      async (
        source: string,
        options: {
          auto?: boolean;
          verbose?: boolean;
          name?: string;
          parallelism?: number;
          dryRun?: boolean;
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

        // Phase 1: Plan
        let planSetName: string | undefined;
        let planFiles: PlanFile[] = [];
        let planResult: 'completed' | 'failed' = 'completed';

        for await (const event of engine.plan(source, {
          auto: options.auto,
          verbose: options.verbose,
          name: options.name,
        })) {
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
          engine.build(planSetName, {
            auto: options.auto,
            verbose: options.verbose,
          }),
          { afterStart: () => renderLangfuseStatus(engine.resolvedConfig) },
        );

        process.exit(buildResult === 'completed' ? 0 : 1);
      },
    );

  program
    .command('build <planSet>')
    .description('Execute plans (implement + review)')
    .option('--auto', 'Run without approval gates')
    .option('--verbose', 'Stream agent output')
    .option('--dry-run', 'Validate and show execution plan without running')
    .option('--parallelism <n>', 'Max parallel plans', parseInt)
    .action(
      async (
        planSet: string,
        options: { auto?: boolean; verbose?: boolean; dryRun?: boolean; parallelism?: number },
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
        const result = await consumeEvents(
          engine.build(planSet, {
            auto: options.auto,
            verbose: options.verbose,
          }),
          { afterStart: () => renderLangfuseStatus(engine.resolvedConfig) },
        );

        process.exit(result === 'completed' ? 0 : 1);
      },
    );

  program
    .command('review <planSet>')
    .description('Review existing code against plans')
    .option('--auto', 'Run without approval gates')
    .option('--verbose', 'Stream agent output')
    .action(async (planSet: string, options: { auto?: boolean; verbose?: boolean }) => {
      initDisplay({ verbose: options.verbose });

      const engine = await ForgeEngine.create({
        onClarification: createClarificationHandler(options.auto ?? false),
        onApproval: createApprovalHandler(options.auto ?? false),
      });
      const result = await consumeEvents(
        engine.review(planSet, {
          auto: options.auto,
          verbose: options.verbose,
        }),
        { afterStart: () => renderLangfuseStatus(engine.resolvedConfig) },
      );

      process.exit(result === 'completed' ? 0 : 1);
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
  setupSignalHandlers();
  const program = createProgram();
  await program.parseAsync();
}

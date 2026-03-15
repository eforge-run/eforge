import chalk from 'chalk';
import ora, { type Ora } from 'ora';
import type { EforgeEvent, EforgeStatus, OrchestrationConfig } from '../engine/events.js';
import type { EforgeConfig } from '../engine/config.js';

// Module-scoped display state
const spinners = new Map<string, Ora>();
let verbose = false;
let startTime = Date.now();

export function initDisplay(opts: { verbose?: boolean } = {}): void {
  verbose = opts.verbose ?? false;
  startTime = Date.now();
}

export function renderLangfuseStatus(config: EforgeConfig): void {
  if (config.langfuse.enabled) {
    console.log(chalk.dim(`  Langfuse: enabled → ${config.langfuse.host}`));
  } else {
    const missing: string[] = [];
    if (!config.langfuse.publicKey) missing.push('LANGFUSE_PUBLIC_KEY');
    if (!config.langfuse.secretKey) missing.push('LANGFUSE_SECRET_KEY');
    if (missing.length > 0) {
      console.log(chalk.dim(`  Langfuse: disabled (missing ${missing.join(', ')})`));
    } else {
      console.log(chalk.dim('  Langfuse: disabled'));
    }
  }
}

export function stopAllSpinners(): void {
  for (const spinner of spinners.values()) {
    spinner.stop();
  }
  spinners.clear();
}

function startSpinner(key: string, text: string): void {
  const existing = spinners.get(key);
  if (existing) existing.stop();
  const spinner = ora(text).start();
  spinners.set(key, spinner);
}

function succeedSpinner(key: string, text?: string): void {
  const spinner = spinners.get(key);
  if (spinner) {
    spinner.succeed(text);
    spinners.delete(key);
  }
}

function failSpinner(key: string, text?: string): void {
  const spinner = spinners.get(key);
  if (spinner) {
    spinner.fail(text);
    spinners.delete(key);
  }
}

function elapsed(): string {
  const ms = Date.now() - startTime;
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

/**
 * Render a single EforgeEvent to stdout.
 * Exhaustive switch with `never` default ensures all event types handled.
 */
export function renderEvent(event: EforgeEvent): void {
  switch (event.type) {
    // Lifecycle
    case 'session:start':
      break;

    case 'session:end':
      break;

    case 'phase:start':
      console.log('');
      console.log(chalk.bold(`\u2692 eforge ${event.command}`));
      console.log(chalk.dim(`  Run: ${event.runId}`));
      if (event.planSet) console.log(chalk.dim(`  Plan set: ${chalk.cyan(event.planSet)}`));
      console.log('');
      break;

    case 'phase:end': {
      stopAllSpinners();
      const icon = event.result.status === 'completed' ? chalk.green('\u2713') : chalk.red('\u2717');
      console.log('');
      console.log(`${icon} ${event.result.summary} ${chalk.dim(`(${elapsed()})`)}`);
      console.log('');
      break;
    }

    // Planning
    case 'plan:start':
      startSpinner('plan', `Planning from ${chalk.cyan(event.source)}...`);
      break;

    case 'plan:scope': {
      const scopeColors: Record<string, (s: string) => string> = {
        complete: chalk.dim,
        errand: chalk.green,
        excursion: chalk.yellow,
        expedition: chalk.magenta,
      };
      const colorFn = scopeColors[event.assessment] ?? chalk.dim;
      console.log(`  Scope: ${colorFn(event.assessment)} \u2014 ${chalk.dim(event.justification)}`);
      break;
    }

    case 'plan:clarification': {
      const spinner = spinners.get('plan');
      if (spinner) spinner.stop();
      console.log('');
      console.log(chalk.yellow('\u26a0 Clarification needed:'));
      for (const q of event.questions) {
        console.log(`  ${chalk.bold(q.question)}`);
        if (q.context) console.log(chalk.dim(`    ${q.context}`));
        if (q.options) console.log(chalk.dim(`    Options: ${q.options.join(', ')}`));
      }
      break;
    }

    case 'plan:clarification:answer':
      startSpinner('plan', 'Continuing planning...');
      break;

    case 'plan:progress': {
      const spinner = spinners.get('plan');
      if (spinner) spinner.text = event.message;
      break;
    }

    case 'plan:complete':
      if (event.plans.length === 0) {
        succeedSpinner('plan', 'Nothing to plan \u2014 source is fully implemented');
      } else {
        succeedSpinner('plan', `Planning complete \u2014 ${event.plans.length} plan(s) created`);
        for (const plan of event.plans) {
          console.log(`  ${chalk.cyan(plan.id)} \u2014 ${plan.name}`);
        }
      }
      break;

    // Plan review (after planning phase)
    case 'plan:review:start':
      startSpinner('plan-review', 'Reviewing plan files...');
      break;

    case 'plan:review:complete': {
      const planIssues = event.issues;
      if (planIssues.length === 0) {
        succeedSpinner('plan-review', 'Plan review complete \u2014 no issues found');
      } else {
        const pCritical = planIssues.filter((i) => i.severity === 'critical').length;
        const pWarnings = planIssues.filter((i) => i.severity === 'warning').length;
        const pSuggestions = planIssues.filter((i) => i.severity === 'suggestion').length;
        const pParts: string[] = [];
        if (pCritical > 0) pParts.push(chalk.red(`${pCritical} critical`));
        if (pWarnings > 0) pParts.push(chalk.yellow(`${pWarnings} warning`));
        if (pSuggestions > 0) pParts.push(chalk.blue(`${pSuggestions} suggestion`));
        succeedSpinner('plan-review', `Plan review: ${pParts.join(', ')}`);
      }
      break;
    }

    case 'plan:evaluate:start':
      startSpinner('plan-evaluate', 'Evaluating plan review fixes...');
      break;

    case 'plan:evaluate:complete':
      if (event.accepted === 0 && event.rejected === 0) {
        succeedSpinner('plan-evaluate', 'Plan evaluation: no fixes to evaluate');
      } else {
        succeedSpinner(
          'plan-evaluate',
          `Plan evaluation: ${chalk.green(`${event.accepted} accepted`)}, ${chalk.red(`${event.rejected} rejected`)}`,
        );
      }
      break;

    // Cohesion review (expedition cross-module validation)
    case 'plan:cohesion:start':
      startSpinner('cohesion-review', 'Reviewing cross-module cohesion...');
      break;

    case 'plan:cohesion:complete': {
      const cohesionIssues = event.issues;
      if (cohesionIssues.length === 0) {
        succeedSpinner('cohesion-review', 'Cohesion review complete \u2014 no issues found');
      } else {
        const cCritical = cohesionIssues.filter((i) => i.severity === 'critical').length;
        const cWarnings = cohesionIssues.filter((i) => i.severity === 'warning').length;
        const cSuggestions = cohesionIssues.filter((i) => i.severity === 'suggestion').length;
        const cParts: string[] = [];
        if (cCritical > 0) cParts.push(chalk.red(`${cCritical} critical`));
        if (cWarnings > 0) cParts.push(chalk.yellow(`${cWarnings} warning`));
        if (cSuggestions > 0) cParts.push(chalk.blue(`${cSuggestions} suggestion`));
        succeedSpinner('cohesion-review', `Cohesion review: ${cParts.join(', ')}`);
      }
      break;
    }

    case 'plan:cohesion:evaluate:start':
      startSpinner('cohesion-evaluate', 'Evaluating cohesion review fixes...');
      break;

    case 'plan:cohesion:evaluate:complete':
      if (event.accepted === 0 && event.rejected === 0) {
        succeedSpinner('cohesion-evaluate', 'Cohesion evaluation: no fixes to evaluate');
      } else {
        succeedSpinner(
          'cohesion-evaluate',
          `Cohesion evaluation: ${chalk.green(`${event.accepted} accepted`)}, ${chalk.red(`${event.rejected} rejected`)}`,
        );
      }
      break;

    // Building (per-plan)
    case 'build:start':
      startSpinner(`build:${event.planId}`, `${chalk.cyan(event.planId)} \u2014 starting...`);
      break;

    case 'build:implement:start': {
      const s = spinners.get(`build:${event.planId}`);
      if (s) s.text = `${chalk.cyan(event.planId)} \u2014 implementing...`;
      break;
    }

    case 'build:implement:progress': {
      const s = spinners.get(`build:${event.planId}`);
      if (s) s.text = `${chalk.cyan(event.planId)} \u2014 ${event.message}`;
      break;
    }

    case 'build:implement:complete': {
      const s = spinners.get(`build:${event.planId}`);
      if (s) s.text = `${chalk.cyan(event.planId)} \u2014 implementation complete`;
      break;
    }

    case 'build:review:start': {
      const s = spinners.get(`build:${event.planId}`);
      if (s) s.text = `${chalk.cyan(event.planId)} \u2014 reviewing...`;
      break;
    }

    case 'build:review:complete': {
      const s = spinners.get(`build:${event.planId}`);
      if (s) s.text = `${chalk.cyan(event.planId)} \u2014 review complete`;
      const issues = event.issues;
      if (issues.length > 0) {
        const critical = issues.filter((i) => i.severity === 'critical').length;
        const warnings = issues.filter((i) => i.severity === 'warning').length;
        const suggestions = issues.filter((i) => i.severity === 'suggestion').length;
        const parts: string[] = [];
        if (critical > 0) parts.push(chalk.red(`${critical} critical`));
        if (warnings > 0) parts.push(chalk.yellow(`${warnings} warning`));
        if (suggestions > 0) parts.push(chalk.blue(`${suggestions} suggestion`));
        console.log(`  ${chalk.cyan(event.planId)} review: ${parts.join(', ')}`);
      }
      break;
    }

    case 'build:review:parallel:start': {
      const s = spinners.get(`build:${event.planId}`);
      if (s) s.text = `${chalk.cyan(event.planId)} \u2014 reviewing: ${event.perspectives.join(', ')}`;
      break;
    }

    case 'build:review:parallel:perspective:start':
      // No-op — spinner already shows perspectives
      break;

    case 'build:review:parallel:perspective:complete': {
      const pIssues = event.issues;
      if (pIssues.length > 0) {
        console.log(chalk.dim(`  ${chalk.cyan(event.planId)} ${event.perspective}: ${pIssues.length} issue(s)`));
      }
      break;
    }

    case 'build:review:fix:start': {
      const s = spinners.get(`build:${event.planId}`);
      if (s) s.text = `${chalk.cyan(event.planId)} \u2014 applying fixes (${event.issueCount} issues)`;
      break;
    }

    case 'build:review:fix:complete': {
      const s = spinners.get(`build:${event.planId}`);
      if (s) s.text = `${chalk.cyan(event.planId)} \u2014 fixes applied`;
      break;
    }

    case 'build:evaluate:start': {
      const s = spinners.get(`build:${event.planId}`);
      if (s) s.text = `${chalk.cyan(event.planId)} \u2014 evaluating fixes...`;
      break;
    }

    case 'build:evaluate:complete': {
      const s = spinners.get(`build:${event.planId}`);
      if (s) s.text = `${chalk.cyan(event.planId)} \u2014 evaluation complete`;
      console.log(
        `  ${chalk.cyan(event.planId)} evaluate: ${chalk.green(`${event.accepted} accepted`)}, ${chalk.red(`${event.rejected} rejected`)}`,
      );
      break;
    }

    case 'build:files_changed':
      console.log(chalk.dim(`  ${chalk.cyan(event.planId)} — ${event.files.length} file(s) changed`));
      break;

    case 'build:complete':
      succeedSpinner(`build:${event.planId}`, `${chalk.cyan(event.planId)} \u2014 complete`);
      break;

    case 'build:failed':
      failSpinner(`build:${event.planId}`, `${chalk.cyan(event.planId)} \u2014 ${chalk.red(event.error)}`);
      break;

    // Orchestration
    case 'wave:start':
      console.log('');
      console.log(
        chalk.magenta(`\u2501\u2501 Wave ${event.wave} \u2501\u2501`) +
          chalk.dim(` [${event.planIds.join(', ')}]`),
      );
      break;

    case 'wave:complete':
      console.log(chalk.magenta(`\u2501\u2501 Wave ${event.wave} complete \u2501\u2501`));
      break;

    case 'merge:start':
      startSpinner(`merge:${event.planId}`, `Merging ${chalk.cyan(event.planId)}...`);
      break;

    case 'merge:complete':
      succeedSpinner(`merge:${event.planId}`, `Merged ${chalk.cyan(event.planId)}`);
      break;

    // Expedition planning phases
    case 'expedition:architecture:complete':
      succeedSpinner('plan', `Architecture complete \u2014 ${event.modules.length} modules defined`);
      for (const mod of event.modules) {
        console.log(`  ${chalk.cyan(mod.id)} \u2014 ${mod.description}`);
      }
      break;

    case 'expedition:module:start':
      startSpinner(`mod:${event.moduleId}`, `Planning module ${chalk.cyan(event.moduleId)}...`);
      break;

    case 'expedition:module:complete':
      succeedSpinner(`mod:${event.moduleId}`, `Module ${chalk.cyan(event.moduleId)} planned`);
      break;

    case 'expedition:compile:start':
      startSpinner('compile', 'Compiling plan files...');
      break;

    case 'expedition:compile:complete':
      succeedSpinner('compile', `Compiled ${event.plans.length} plan file(s)`);
      break;

    // Validation (post-merge)
    case 'validation:start':
      console.log('');
      console.log(chalk.bold('Running post-merge validation...'));
      for (const cmd of event.commands) {
        console.log(chalk.dim(`  \u2022 ${cmd}`));
      }
      break;

    case 'validation:command:start':
      startSpinner(`validation:${event.command}`, `Running: ${chalk.cyan(event.command)}`);
      break;

    case 'validation:command:complete':
      if (event.exitCode === 0) {
        succeedSpinner(`validation:${event.command}`, `${chalk.cyan(event.command)} ${chalk.green('passed')}`);
      } else {
        failSpinner(`validation:${event.command}`, `${chalk.cyan(event.command)} ${chalk.red(`failed (exit ${event.exitCode})`)}`);
        if (event.output) {
          console.log(chalk.dim(event.output));
        }
      }
      break;

    case 'validation:complete':
      if (event.passed) {
        console.log(chalk.green('\u2713 All validation commands passed'));
      } else {
        console.log(chalk.red('\u2717 Validation failed'));
      }
      break;

    case 'validation:fix:start':
      console.log('');
      console.log(chalk.yellow(`Attempting validation fix (${event.attempt}/${event.maxAttempts})...`));
      startSpinner('validation-fix', `Fixing validation failures (attempt ${event.attempt})`);
      break;

    case 'validation:fix:complete':
      succeedSpinner('validation-fix', `Validation fix attempt ${event.attempt} complete`);
      break;

    // Agent-level (verbose streaming)
    case 'agent:message':
      if (!verbose) break;
      console.log(
        chalk.dim(`  [${event.agent}${event.planId ? `:${event.planId}` : ''}] ${event.content}`),
      );
      break;

    case 'agent:tool_use':
      if (!verbose) break;
      console.log(
        chalk.dim(
          `  [${event.agent}${event.planId ? `:${event.planId}` : ''}] \u2192 ${event.tool}`,
        ),
      );
      break;

    case 'agent:tool_result':
      if (!verbose) break;
      console.log(
        chalk.dim(
          `  [${event.agent}${event.planId ? `:${event.planId}` : ''}] \u2190 ${event.tool}`,
        ),
      );
      break;

    case 'agent:result':
      // Tracing-only event — no CLI output needed
      break;

    // User interaction
    case 'approval:needed':
      stopAllSpinners();
      console.log('');
      console.log(chalk.yellow(`\u26a0 Approval needed: ${event.action}`));
      console.log(`  ${event.details}`);
      break;

    case 'approval:response':
      console.log(event.approved ? chalk.green('  \u2713 Approved') : chalk.red('  \u2717 Denied'));
      break;

    // Cleanup (post-build)
    case 'cleanup:start':
      startSpinner('cleanup', `Cleaning up plan files for ${chalk.cyan(event.planSet)}...`);
      break;

    case 'cleanup:complete':
      succeedSpinner('cleanup', `Plan files removed for ${chalk.cyan(event.planSet)}`);
      break;

    // Agent lifecycle (consumed by hooks, monitor, tracing — no CLI display)
    case 'agent:start':
    case 'agent:stop':
      break;

    default: {
      const _exhaustive: never = event;
      console.log(chalk.dim(`  Unknown event: ${JSON.stringify(_exhaustive)}`));
    }
  }
}

/**
 * Render the current eforge status as a formatted table.
 */
export function renderStatus(status: EforgeStatus): void {
  if (!status.running && Object.keys(status.plans).length === 0) {
    console.log(chalk.dim('No active builds.'));
    return;
  }

  if (status.setName) {
    console.log(chalk.bold(`Plan set: ${chalk.cyan(status.setName)}`));
  }
  console.log(chalk.bold(status.running ? chalk.green('Running') : chalk.dim('Idle')));
  console.log('');

  const statusIcons: Record<string, string> = {
    pending: chalk.dim('\u25cb'),
    running: chalk.blue('\u25c9'),
    completed: chalk.green('\u2713'),
    failed: chalk.red('\u2717'),
    blocked: chalk.yellow('\u2298'),
    merged: chalk.green('\u2295'),
  };

  for (const [id, planStatus] of Object.entries(status.plans)) {
    const icon = statusIcons[planStatus] ?? chalk.dim('?');
    console.log(`  ${icon} ${chalk.cyan(id)} \u2014 ${planStatus}`);
  }

  if (status.completedPlans.length > 0) {
    console.log('');
    console.log(chalk.dim(`Completed: ${status.completedPlans.join(', ')}`));
  }
}

/**
 * Render a dry-run execution plan display.
 */
export function renderDryRun(
  config: OrchestrationConfig,
  waves: string[][],
  mergeOrder: string[],
): void {
  console.log('');
  console.log(chalk.bold(`Dry run: ${chalk.cyan(config.name)}`));
  if (config.description) console.log(chalk.dim(config.description));
  console.log('');

  console.log(chalk.bold('Execution plan:'));
  for (let i = 0; i < waves.length; i++) {
    console.log(chalk.magenta(`  Wave ${i + 1}:`));
    for (const planId of waves[i]) {
      const plan = config.plans.find((p) => p.id === planId);
      const deps = plan?.dependsOn.length
        ? chalk.dim(` (depends on: ${plan.dependsOn.join(', ')})`)
        : '';
      console.log(`    ${chalk.cyan(planId)} \u2014 ${plan?.name ?? ''}${deps}`);
    }
  }

  console.log('');
  console.log(chalk.bold('Merge order:'));
  for (let i = 0; i < mergeOrder.length; i++) {
    console.log(`  ${i + 1}. ${chalk.cyan(mergeOrder[i])}`);
  }
  console.log('');
}

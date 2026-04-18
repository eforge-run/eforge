import chalk from 'chalk';
import ora, { type Ora } from 'ora';
import type { EforgeEvent, EforgeStatus, OrchestrationConfig, ReviewIssue } from '@eforge-build/engine/events';
import type { EforgeConfig } from '@eforge-build/engine/config';
import type { QueuedPrd } from '@eforge-build/engine/prd-queue';

// Module-scoped display state
const spinners = new Map<string, Ora>();
let verbose = false;
let startTime = Date.now();

/** Per-agent buffer for streaming text - avoids one-token-per-line noise. */
const agentTextBuffers = new Map<string, string>();

function agentBufferKey(agent: string, planId?: string): string {
  return planId ? `${agent}:${planId}` : agent;
}

function flushAgentBuffer(agent: string, planId?: string): void {
  const key = agentBufferKey(agent, planId);
  const buf = agentTextBuffers.get(key);
  if (!buf) return;
  agentTextBuffers.delete(key);
  const prefix = chalk.dim(`  [${planId ? `${agent}:${planId}` : agent}] `);
  // Print each buffered line with the agent prefix
  for (const line of buf.split('\n')) {
    console.log(prefix + chalk.dim(line));
  }
}

function appendAgentBuffer(agent: string, planId: string | undefined, content: string): void {
  const key = agentBufferKey(agent, planId);
  const existing = agentTextBuffers.get(key) ?? '';
  const combined = existing + content;

  // If the content contains newlines, flush complete lines and keep the remainder
  const lastNewline = combined.lastIndexOf('\n');
  if (lastNewline !== -1) {
    const toFlush = combined.slice(0, lastNewline);
    const remainder = combined.slice(lastNewline + 1);
    const prefix = chalk.dim(`  [${planId ? `${agent}:${planId}` : agent}] `);
    for (const line of toFlush.split('\n')) {
      console.log(prefix + chalk.dim(line));
    }
    agentTextBuffers.set(key, remainder);
  } else {
    agentTextBuffers.set(key, combined);
  }
}

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

function formatIssueSummary(issues: ReviewIssue[]): string {
  const critical = issues.filter((i) => i.severity === 'critical').length;
  const warnings = issues.filter((i) => i.severity === 'warning').length;
  const suggestions = issues.filter((i) => i.severity === 'suggestion').length;
  const parts: string[] = [];
  if (critical > 0) parts.push(chalk.red(`${critical} critical`));
  if (warnings > 0) parts.push(chalk.yellow(`${warnings} warning`));
  if (suggestions > 0) parts.push(chalk.blue(`${suggestions} suggestion`));
  return parts.join(', ');
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
      startSpinner('plan', `Planning from ${chalk.cyan(event.label ?? event.source)}...`);
      break;

    case 'plan:skip':
      console.log(chalk.dim(`  Skipped: ${event.reason}`));
      break;

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

    case 'plan:continuation': {
      const s = spinners.get('plan');
      if (s) s.text = `Planning - continuing (attempt ${event.attempt}/${event.maxContinuations})`;
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
      if (event.issues.length === 0) {
        succeedSpinner('plan-review', 'Plan review complete \u2014 no issues found');
      } else {
        succeedSpinner('plan-review', `Plan review: ${formatIssueSummary(event.issues)}`);
      }
      break;
    }

    case 'plan:evaluate:start':
      startSpinner('plan-evaluate', 'Evaluating plan review fixes...');
      break;

    case 'plan:evaluate:continuation': {
      const s = spinners.get('plan-evaluate');
      if (s) s.text = `Evaluating plan review fixes - continuing (attempt ${event.attempt}/${event.maxContinuations})`;
      break;
    }

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

    // Architecture review (expedition architecture validation)
    case 'plan:architecture:review:start':
      startSpinner('architecture-review', 'Reviewing architecture...');
      break;

    case 'plan:architecture:review:complete': {
      if (event.issues.length === 0) {
        succeedSpinner('architecture-review', 'Architecture review complete \u2014 no issues found');
      } else {
        succeedSpinner('architecture-review', `Architecture review: ${formatIssueSummary(event.issues)}`);
      }
      break;
    }

    case 'plan:architecture:evaluate:start':
      startSpinner('architecture-evaluate', 'Evaluating architecture review fixes...');
      break;

    case 'plan:architecture:evaluate:continuation': {
      const s = spinners.get('architecture-evaluate');
      if (s) s.text = `Evaluating architecture review fixes - continuing (attempt ${event.attempt}/${event.maxContinuations})`;
      break;
    }

    case 'plan:architecture:evaluate:complete':
      if (event.accepted === 0 && event.rejected === 0) {
        succeedSpinner('architecture-evaluate', 'Architecture evaluation: no fixes to evaluate');
      } else {
        succeedSpinner(
          'architecture-evaluate',
          `Architecture evaluation: ${chalk.green(`${event.accepted} accepted`)}, ${chalk.red(`${event.rejected} rejected`)}`,
        );
      }
      break;

    // Cohesion review (expedition cross-module validation)
    case 'plan:cohesion:start':
      startSpinner('cohesion-review', 'Reviewing cross-module cohesion...');
      break;

    case 'plan:cohesion:complete': {
      if (event.issues.length === 0) {
        succeedSpinner('cohesion-review', 'Cohesion review complete \u2014 no issues found');
      } else {
        succeedSpinner('cohesion-review', `Cohesion review: ${formatIssueSummary(event.issues)}`);
      }
      break;
    }

    case 'plan:cohesion:evaluate:start':
      startSpinner('cohesion-evaluate', 'Evaluating cohesion review fixes...');
      break;

    case 'plan:cohesion:evaluate:continuation': {
      const s = spinners.get('cohesion-evaluate');
      if (s) s.text = `Evaluating cohesion review fixes - continuing (attempt ${event.attempt}/${event.maxContinuations})`;
      break;
    }

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

    case 'build:implement:continuation': {
      const s = spinners.get(`build:${event.planId}`);
      if (s) s.text = `${chalk.cyan(event.planId)} \u2014 continuing (attempt ${event.attempt}/${event.maxContinuations})`;
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
      if (event.issues.length > 0) {
        console.log(`  ${chalk.cyan(event.planId)} review: ${formatIssueSummary(event.issues)}`);
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

    case 'build:evaluate:continuation': {
      const s = spinners.get(`build:${event.planId}`);
      if (s) s.text = `${chalk.cyan(event.planId)} \u2014 evaluating fixes - continuing (attempt ${event.attempt}/${event.maxContinuations})`;
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

    case 'build:doc-update:start': {
      const s = spinners.get(`build:${event.planId}`);
      if (s) s.text = `${chalk.cyan(event.planId)} — updating docs...`;
      break;
    }

    case 'build:doc-update:complete': {
      if (event.docsUpdated > 0) {
        const s = spinners.get(`build:${event.planId}`);
        if (s) s.text = `${chalk.cyan(event.planId)} — ${event.docsUpdated} doc(s) updated`;
      }
      break;
    }

    case 'build:test:write:start': {
      const s = spinners.get(`build:${event.planId}`);
      if (s) s.text = `${chalk.cyan(event.planId)} — writing tests...`;
      break;
    }

    case 'build:test:write:complete': {
      if (event.testsWritten > 0) {
        const s = spinners.get(`build:${event.planId}`);
        if (s) s.text = `${chalk.cyan(event.planId)} — ${event.testsWritten} test file(s) written`;
      }
      break;
    }

    case 'build:test:start': {
      const s = spinners.get(`build:${event.planId}`);
      if (s) s.text = `${chalk.cyan(event.planId)} — running tests...`;
      break;
    }

    case 'build:test:complete': {
      const s = spinners.get(`build:${event.planId}`);
      if (s) {
        const parts = [`${event.passed} passed`];
        if (event.failed > 0) parts.push(`${event.failed} failed`);
        if (event.testBugsFixed > 0) parts.push(`${event.testBugsFixed} test bugs fixed`);
        if (event.productionIssues.length > 0) parts.push(`${event.productionIssues.length} production issue(s)`);
        s.text = `${chalk.cyan(event.planId)} — tests: ${parts.join(', ')}`;
      }
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
    case 'schedule:start':
      console.log('');
      console.log(
        chalk.magenta(`\u2501\u2501 Scheduling \u2501\u2501`) +
          chalk.dim(` [${event.planIds.join(', ')}]`),
      );
      break;

    case 'schedule:ready':
      console.log(chalk.magenta(`  \u25b8 Ready: ${chalk.cyan(event.planId)}`) + chalk.dim(` (${event.reason})`));
      break;

    case 'merge:start':
      startSpinner(`merge:${event.planId}`, `Merging ${chalk.cyan(event.planId)}...`);
      break;

    case 'merge:complete':
      succeedSpinner(`merge:${event.planId}`, `Merged ${chalk.cyan(event.planId)}`);
      break;

    case 'merge:finalize:start':
      startSpinner('merge-finalize', `Merging ${chalk.cyan(event.featureBranch)} into ${chalk.cyan(event.baseBranch)}...`);
      break;

    case 'merge:finalize:complete':
      succeedSpinner('merge-finalize', `Merged ${chalk.cyan(event.featureBranch)} into ${chalk.cyan(event.baseBranch)}`);
      break;

    case 'merge:finalize:skipped':
      console.log(chalk.yellow(`  ⏭ Feature branch merge skipped: ${event.reason}`));
      console.log(chalk.dim(`    Branch ${chalk.cyan(event.featureBranch)} left for inspection`));
      break;

    // Expedition planning phases
    case 'expedition:architecture:complete':
      succeedSpinner('plan', `Architecture complete \u2014 ${event.modules.length} modules defined`);
      for (const mod of event.modules) {
        console.log(`  ${chalk.cyan(mod.id)} \u2014 ${mod.description}`);
      }
      break;

    case 'expedition:wave:start':
      console.log('');
      console.log(
        chalk.magenta(`\u2501\u2501 Module wave ${event.wave} \u2501\u2501`) +
          chalk.dim(` [${event.moduleIds.join(', ')}]`),
      );
      break;

    case 'expedition:wave:complete':
      console.log(chalk.magenta(`\u2501\u2501 Module wave ${event.wave} complete \u2501\u2501`));
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
      appendAgentBuffer(event.agent, event.planId, event.content);
      break;

    case 'agent:tool_use':
      if (!verbose) break;
      flushAgentBuffer(event.agent, event.planId);
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

    // Reconciliation (resume)
    case 'reconciliation:start':
      startSpinner('reconciliation', 'Reconciling worktree state...');
      break;

    case 'reconciliation:complete': {
      const r = event.report;
      const parts: string[] = [];
      if (r.valid.length > 0) parts.push(chalk.green(`${r.valid.length} valid`));
      if (r.missing.length > 0) parts.push(chalk.yellow(`${r.missing.length} missing`));
      if (r.corrupt.length > 0) parts.push(chalk.red(`${r.corrupt.length} corrupt`));
      succeedSpinner('reconciliation', `Reconciliation complete: ${parts.join(', ')}`);
      break;
    }

    // Cleanup (post-build)
    case 'cleanup:start':
      startSpinner('cleanup', `Cleaning up plan files for ${chalk.cyan(event.planSet)}...`);
      break;

    case 'cleanup:complete':
      succeedSpinner('cleanup', `Plan files removed for ${chalk.cyan(event.planSet)}`);
      break;

    case 'plan:pipeline': {
      const scopeColors: Record<string, (s: string) => string> = {
        errand: chalk.green,
        excursion: chalk.yellow,
        expedition: chalk.magenta,
      };
      const scopeColorFn = scopeColors[event.scope] ?? chalk.cyan;
      console.log(`  Pipeline: ${scopeColorFn(event.scope)} - ${chalk.dim(event.rationale)}`);
      break;
    }

    // Agent lifecycle (consumed by hooks, monitor, tracing — no CLI display)
    case 'agent:start':
      break;
    case 'agent:warning':
      break;
    case 'agent:stop':
      flushAgentBuffer(event.agent, event.planId);
      break;
    case 'agent:usage':
      break;

    // Merge conflict resolution
    case 'merge:resolve:start':
      console.log(chalk.yellow(`  ⚡ Resolving merge conflicts for ${event.planId}...`));
      break;
    case 'merge:resolve:complete':
      if (event.resolved) {
        console.log(chalk.green(`  ✓ Merge conflicts resolved for ${event.planId}`));
      } else {
        console.log(chalk.red(`  ✗ Failed to resolve merge conflicts for ${event.planId}`));
      }
      break;

    // Queue events
    case 'queue:start':
      console.log('');
      console.log(chalk.bold(`\u{1F4CB} PRD Queue`));
      console.log(chalk.dim(`  Directory: ${event.dir}`));
      console.log(chalk.dim(`  PRDs to process: ${event.prdCount}`));
      console.log('');
      break;

    case 'queue:prd:start':
      startSpinner(`queue:${event.prdId}`, `Processing ${chalk.cyan(event.title)}...`);
      break;

    case 'queue:prd:stale': {
      const verdictColors: Record<string, (s: string) => string> = {
        proceed: chalk.green,
        revise: chalk.yellow,
        obsolete: chalk.red,
      };
      const verdictFn = verdictColors[event.verdict] ?? chalk.dim;
      console.log(`  Staleness: ${verdictFn(event.verdict)} \u2014 ${chalk.dim(event.justification)}`);
      break;
    }

    case 'queue:prd:skip':
      console.log(chalk.dim(`  Skipped: ${event.prdId} \u2014 ${event.reason}`));
      break;

    case 'queue:prd:complete':
      if (event.status === 'completed') {
        succeedSpinner(`queue:${event.prdId}`, `${chalk.cyan(event.prdId)} \u2014 completed`);
      } else {
        failSpinner(`queue:${event.prdId}`, `${chalk.cyan(event.prdId)} \u2014 ${chalk.red('failed')}`);
      }
      break;

    case 'queue:complete':
      console.log('');
      console.log(
        chalk.bold('Queue complete: ') +
        chalk.green(`${event.processed} processed`) +
        (event.skipped > 0 ? chalk.dim(`, ${event.skipped} skipped`) : ''),
      );
      console.log('');
      break;

    case 'queue:prd:discovered':
      console.log(chalk.cyan(`  Discovered new PRD: ${event.title} (${event.prdId})`));
      break;

    case 'enqueue:start':
      startSpinner('enqueue', `Enqueuing from ${chalk.cyan(event.source)}...`);
      break;

    case 'enqueue:complete':
      succeedSpinner('enqueue', `Enqueued: ${chalk.cyan(event.title)} -> ${chalk.dim(event.filePath)}`);
      break;

    case 'enqueue:failed':
      failSpinner('enqueue', `Enqueue failed: ${chalk.red(event.error)}`);
      break;

    case 'enqueue:commit-failed':
      console.log(chalk.yellow(`  ⚠ Enqueue commit failed (non-fatal): ${event.error}`));
      break;

    case 'queue:prd:commit-failed':
      console.log(chalk.yellow(`  ⚠ PRD ${event.prdId} commit failed (non-fatal): ${event.error}`));
      break;

    case 'prd_validation:start':
      startSpinner('prd-validation', 'PRD Validation...');
      break;

    case 'prd_validation:complete':
      if (event.passed) {
        const pctMsg = event.completionPercent !== undefined ? ` ${event.completionPercent}% complete,` : '';
        succeedSpinner('prd-validation', chalk.green(`PRD Validation passed:${pctMsg} no gaps`));
      } else {
        const pctMsg = event.completionPercent !== undefined ? `${event.completionPercent}% complete, ` : '';
        failSpinner('prd-validation', chalk.red(`PRD Validation failed: ${pctMsg}${event.gaps.length} gap(s) found`));
        for (const gap of event.gaps) {
          console.log(chalk.red(`  - ${gap.requirement}: ${gap.explanation}`));
        }
        // Show complexity breakdown if any gaps have complexity
        const trivial = event.gaps.filter((g) => g.complexity === 'trivial').length;
        const moderate = event.gaps.filter((g) => g.complexity === 'moderate').length;
        const significant = event.gaps.filter((g) => g.complexity === 'significant').length;
        if (trivial + moderate + significant > 0) {
          const parts: string[] = [];
          if (trivial > 0) parts.push(`${trivial} trivial`);
          if (moderate > 0) parts.push(`${moderate} moderate`);
          if (significant > 0) parts.push(`${significant} significant`);
          console.log(chalk.dim(`  ${parts.join(', ')}`));
        }
      }
      break;

    case 'gap_close:start':
      startSpinner('gap-close', 'Closing PRD validation gaps...');
      break;

    case 'gap_close:plan_ready':
      break;

    case 'gap_close:complete':
      succeedSpinner('gap-close', 'Gap closing complete');
      break;

    case 'plan:submission':
      break;

    case 'plan:error':
      failSpinner('plan', `Planning failed: ${event.reason}`);
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
 * Render the PRD queue as a formatted table, grouped by location-based status.
 * Accepts separate arrays for each state (pending, running, failed, skipped).
 */
export function renderQueueList(groups: {
  pending: QueuedPrd[];
  running: QueuedPrd[];
  failed: QueuedPrd[];
  skipped: QueuedPrd[];
}): void {
  const total = groups.pending.length + groups.running.length + groups.failed.length + groups.skipped.length;
  if (total === 0) {
    console.log(chalk.dim('No PRDs in queue.'));
    return;
  }

  function staleDaysColor(days: number): string {
    const padded = String(days).padStart(5);
    if (days < 7) return chalk.green(padded);
    if (days <= 14) return chalk.yellow(padded);
    return chalk.red(padded);
  }

  function renderGroup(group: QueuedPrd[], label: string, dim: boolean): void {
    if (group.length === 0) return;

    console.log('');
    console.log(dim ? chalk.dim(label) : chalk.bold(label));
    console.log(
      dim
        ? chalk.dim('  Priority  Title                          Created      Stale  Depends On')
        : '  Priority  Title                          Created      Stale  Depends On',
    );
    console.log(chalk.dim('  --------  -----------------------------  -----------  -----  ----------'));

    const TITLE_COL_WIDTH = 29;

    for (const prd of group) {
      const pri = prd.frontmatter.priority !== undefined ? String(prd.frontmatter.priority) : '-';
      const title = prd.frontmatter.title.length > TITLE_COL_WIDTH
        ? prd.frontmatter.title.slice(0, TITLE_COL_WIDTH - 1) + '\u2026'
        : prd.frontmatter.title;
      const created = prd.frontmatter.created ?? '-';
      const deps = prd.frontmatter.depends_on?.join(', ') ?? '-';

      let staleDaysStr: string;
      if (prd.frontmatter.created) {
        const createdDate = new Date(prd.frontmatter.created);
        const days = Math.floor((Date.now() - createdDate.getTime()) / (1000 * 60 * 60 * 24));
        const padded = String(days).padStart(5);
        staleDaysStr = dim ? chalk.dim(padded) : staleDaysColor(days);
      } else {
        staleDaysStr = '    -';
      }

      const line = `  ${pri.padEnd(10)}${title.padEnd(TITLE_COL_WIDTH + 2)}  ${created.padEnd(13)}${staleDaysStr}  ${deps}`;
      console.log(dim ? chalk.dim(line) : line);
    }
  }

  renderGroup(groups.pending, 'Pending', false);
  renderGroup(groups.running, 'Running', false);
  renderGroup(groups.failed, 'Failed', true);
  renderGroup(groups.skipped, 'Skipped', true);
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

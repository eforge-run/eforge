/**
 * Unified retry policy for pipeline agents.
 *
 * Per-agent retry/continuation handling used to live as ad-hoc loops inside
 * `pipeline.ts` — each loop reached for its own predicates (max-turns,
 * dropped-submission), built its own continuation input (plan-dir scan,
 * completed-diff, evaluator re-entry), and emitted its own domain
 * continuation event.
 *
 * This module consolidates the pattern:
 *
 *   const policy = DEFAULT_RETRY_POLICIES[role];
 *   yield* withRetry(runAgent, policy, initialInput);
 *
 * `withRetry` iterates up to `policy.maxAttempts` attempts, yields every
 * event from each attempt, emits a generic `agent:retry` event + any policy
 * `onRetry` events between attempts, and rethrows (or propagates a held-back
 * terminal event) once attempts are exhausted.
 */

import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import type { AgentTerminalSubtype } from './backend.js';
import { AgentTerminalError, isPlannerSubmissionError } from './backend.js';
import { forgeCommit } from './git.js';
import { composeCommitMessage } from './model-tracker.js';
import { parsePlanFile } from './plan.js';
import type { EforgeEvent, AgentRole } from './events.js';

const exec = promisify(execFile);

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

/**
 * Summary of a just-failed attempt passed to policy hooks so they can decide
 * whether to retry and (if so) build the next attempt's input.
 */
export interface RetryAttemptInfo<Input> {
  /** 1-indexed attempt that just failed. */
  attempt: number;
  /** Maximum attempts allowed by the policy. */
  maxAttempts: number;
  /** Terminal subtype extracted from the thrown error or yielded terminal event. */
  subtype: AgentTerminalSubtype;
  /** Events yielded during the attempt (including any held-back terminal event). */
  events: EforgeEvent[];
  /** The input that was passed to the attempt that just failed. */
  prevInput: Input;
  /** The error thrown by the attempt, if any (undefined when the attempt yielded a terminal event but did not throw). */
  error?: unknown;
}

/**
 * A continuation decision returned by `RetryPolicy.buildContinuationInput`.
 *
 * - `retry` — run another attempt with `input`.
 * - `abort-success` — stop retrying and treat the current state as a success.
 *   Used by the evaluator to short-circuit when the worktree became clean
 *   during the failed attempt (nothing left to evaluate).
 */
export type ContinuationDecision<Input> =
  | { kind: 'retry'; input: Input }
  | { kind: 'abort-success' };

/**
 * Retry policy for a single agent role.
 *
 * A policy describes:
 * - Which terminal subtypes are retryable (`retryableSubtypes`).
 * - An optional predicate that can approve retries based on events the agent
 *   emitted (`shouldRetry`) — used by the planner to detect dropped
 *   submissions which don't correspond to an SDK terminal subtype.
 * - How to build the next attempt's input given the failed attempt's events
 *   (`buildContinuationInput`). This is where agent-specific side effects
 *   like committing plan artifacts or building a completed-diff live.
 * - An optional `onRetry` hook that emits agent-specific continuation events
 *   (e.g. `plan:continuation`, `build:implement:continuation`) in addition
 *   to the generic `agent:retry` event emitted by the wrapper.
 */
export interface RetryPolicy<Input> {
  /** Agent role this policy applies to — used to stamp the `agent:retry` event. */
  agent: AgentRole;
  /** Total attempts allowed (`maxAttempts >= 1`). Retries allowed = `maxAttempts - 1`. */
  maxAttempts: number;
  /** Terminal subtypes that trigger a retry. */
  retryableSubtypes: ReadonlySet<AgentTerminalSubtype>;
  /** Optional extra predicate evaluated when `retryableSubtypes.has(subtype)` is false. */
  shouldRetry?: (info: RetryAttemptInfo<Input>) => boolean;
  /** Compute the next attempt's input from the failed attempt. May perform side effects (git, fs). */
  buildContinuationInput?: (info: RetryAttemptInfo<Input>) => Promise<ContinuationDecision<Input>> | ContinuationDecision<Input>;
  /** Emit agent-specific continuation events (e.g. `plan:continuation`) alongside `agent:retry`. */
  onRetry?: (info: RetryAttemptInfo<Input>) => EforgeEvent[];
  /** Short human-readable label used in the `agent:retry` event (e.g. `'planner-continuation'`). */
  label: string;
  /** Optional planId extraction for the `agent:retry` event. */
  planIdFromInput?: (input: Input) => string | undefined;
}

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

/**
 * True when the events collected during a failed planner attempt indicate a
 * dropped submission — the agent completed the stream without calling either
 * of the submission tools (`submit_plan_set` / `submit_architecture`) and
 * without emitting a `<skip>` block that the planner surfaces as `plan:skip`.
 *
 * The check is "absence of a successful submission" rather than "presence of
 * a PlannerSubmissionError" so it works from just the event record, keeping
 * the predicate usable without the thrown error.
 */
export function isDroppedSubmission(events: readonly EforgeEvent[]): boolean {
  let sawSubmissionToolUse = false;
  let sawSkip = false;
  for (const ev of events) {
    if (ev.type === 'agent:tool_use' && (ev.tool === 'submit_plan_set' || ev.tool === 'submit_architecture')) {
      sawSubmissionToolUse = true;
    }
    if (ev.type === 'planning:skip') {
      sawSkip = true;
    }
  }
  return !sawSubmissionToolUse && !sawSkip;
}

// ---------------------------------------------------------------------------
// Internal helpers (duplicated from pipeline.ts to avoid circular imports)
// ---------------------------------------------------------------------------

/**
 * Commit plan artifacts as a checkpoint. No-ops safely when the plan directory
 * does not exist (happens on a dropped-submission retry where no files were
 * written). Mirrors the implementation in pipeline.ts — kept here so the
 * planner continuation builder can drive the side effect without creating
 * a circular dependency with `pipeline.ts`.
 */
export async function commitPlanArtifacts(
  commitCwd: string,
  planSetName: string,
  planFilesCwd?: string,
  outputDir?: string,
): Promise<void> {
  const planDir = resolve(planFilesCwd ?? commitCwd, outputDir ?? 'eforge/plans', planSetName);
  if (!existsSync(planDir)) return;
  await exec('git', ['add', planDir], { cwd: commitCwd });
  const { stdout: staged } = await exec('git', ['diff', '--cached', '--name-only'], { cwd: commitCwd });
  if (staged.trim().length === 0) return;
  await forgeCommit(commitCwd, composeCommitMessage(`plan(${planSetName}): initial planning artifacts`));
}

/**
 * Build a truncating continuation diff from a worktree. Mirrors the
 * implementation in pipeline.ts.
 */
export async function buildContinuationDiff(cwd: string, baseBranch: string): Promise<string> {
  const DIFF_CHAR_LIMIT = 50_000;
  const { stdout: diff } = await exec('git', ['diff', `${baseBranch}...HEAD`], { cwd });
  if (diff.length <= DIFF_CHAR_LIMIT) return diff;
  const { stdout: stat } = await exec('git', ['diff', '--stat', `${baseBranch}...HEAD`], { cwd });
  return `[Diff too large (${diff.length} chars) — showing file summary instead]\n\n${stat}`;
}

/** Check if a worktree has unstaged changes. */
async function hasUnstagedChangesInternal(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await exec('git', ['diff', '--name-only'], { cwd });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/** Check if a worktree has any working-tree changes (staged or unstaged). */
async function hasAnyChanges(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await exec('git', ['status', '--porcelain'], { cwd });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Continuation-input builders (per-agent)
// ---------------------------------------------------------------------------

/**
 * Shape of the side-effect context a planner continuation builder needs.
 * Callers stash this into the planner Input so the continuation builder can
 * reach the right cwd / output dir without fishing through options.
 */
export interface PlannerContinuationSideEffects {
  cwd: string;
  planCommitCwd?: string;
  planSetName: string;
  outputDir: string;
}

/**
 * Minimal shape of the planner input the continuation builder must be able
 * to splice a `continuationContext` into. Real callers pass the full
 * `PlannerOptions`-shaped object; this type just pins the fields the
 * continuation builder touches, keeping the policy reusable.
 */
export interface PlannerContinuationInput {
  sideEffects: PlannerContinuationSideEffects;
  plannerOptions: Record<string, unknown> & {
    continuationContext?: {
      attempt: number;
      maxContinuations: number;
      existingPlans: string;
      reason: 'max_turns' | 'dropped_submission';
    };
  };
}

/**
 * Build the next planner attempt's input:
 * - Checkpoint plan artifacts via `commitPlanArtifacts` (side effect).
 * - Scan the plan directory (skip scan on dropped_submission) to build the
 *   `existingPlans` summary.
 * - Splice `continuationContext` into the planner options.
 */
export async function buildPlannerContinuationInput(
  info: RetryAttemptInfo<PlannerContinuationInput>,
): Promise<ContinuationDecision<PlannerContinuationInput>> {
  const { sideEffects, plannerOptions } = info.prevInput;
  const reason: 'max_turns' | 'dropped_submission' =
    info.subtype === 'error_max_turns' ? 'max_turns' : 'dropped_submission';

  // Checkpoint plan files written so far. Safe no-op when the plan dir
  // doesn't exist (dropped-submission attempts typically wrote nothing).
  await commitPlanArtifacts(
    sideEffects.planCommitCwd ?? sideEffects.cwd,
    sideEffects.planSetName,
    sideEffects.cwd,
    sideEffects.outputDir,
  );

  let existingPlans: string;
  if (reason === 'dropped_submission') {
    existingPlans = '[No existing plans — previous attempt did not submit]';
  } else {
    existingPlans = '[No existing plans found]';
    const planDir = resolve(sideEffects.cwd, sideEffects.outputDir, sideEffects.planSetName);
    if (existsSync(planDir)) {
      try {
        const entries = await readdir(planDir);
        const mdFiles = entries.filter((f) => f.endsWith('.md')).sort();
        const summaries: string[] = [];
        for (const file of mdFiles) {
          try {
            const plan = await parsePlanFile(resolve(planDir, file));
            summaries.push(`- **${plan.id}**: ${plan.name}`);
          } catch {
            summaries.push(`- ${file} (could not parse frontmatter)`);
          }
        }
        if (summaries.length > 0) existingPlans = summaries.join('\n');
      } catch {
        // Leave default text.
      }
    }
  }

  const nextAttempt = info.attempt; // 1-indexed attempt that just failed; next attempt = attempt (since event uses 1-indexed for the upcoming run)
  const nextInput: PlannerContinuationInput = {
    sideEffects,
    plannerOptions: {
      ...plannerOptions,
      continuationContext: {
        attempt: nextAttempt,
        maxContinuations: info.maxAttempts - 1,
        existingPlans,
        reason,
      },
    },
  };
  return { kind: 'retry', input: nextInput };
}

/**
 * Shape of the builder input the continuation builder must be able to
 * augment with the completed-diff continuation context.
 */
export interface BuilderContinuationInput {
  worktreePath: string;
  baseBranch: string;
  planId: string;
  builderOptions: Record<string, unknown> & {
    continuationContext?: {
      attempt: number;
      maxContinuations: number;
      completedDiff: string;
    };
  };
}

/**
 * Build the next builder attempt's input:
 * - Abort (fail) if the worktree has no changes worth checkpointing.
 * - Stage all and checkpoint commit (side effect).
 * - Capture a completed diff summary and splice it into builder options as
 *   `continuationContext`.
 *
 * If the worktree has no changes, return `{ kind: 'abort-success' }` is NOT
 * right — the semantic is "no progress, fail the build". We still return
 * `retry` with a synthetic empty diff; the pipeline can decide to hard-fail
 * when no changes are present via a wrapper check. To preserve prior
 * behavior (hard-fail when no changes), we use a sentinel `abort-fail` style
 * by throwing — but the `ContinuationDecision` type has no such variant, so
 * callers that need that semantic implement the check themselves in a
 * pre-retry guard.
 */
export async function buildBuilderContinuationInput(
  info: RetryAttemptInfo<BuilderContinuationInput>,
): Promise<ContinuationDecision<BuilderContinuationInput>> {
  const { worktreePath, baseBranch, planId, builderOptions } = info.prevInput;

  // If the worktree has no changes at all, there's nothing to build on —
  // propagate the failure by rethrowing the captured error via abort-fail.
  // We signal this by throwing a descriptive Error; withRetry surfaces it
  // to the caller.
  const hasChanges = await hasAnyChanges(worktreePath);
  if (!hasChanges) {
    throw new Error(`Builder continuation aborted: no changes to checkpoint (planId=${planId})`);
  }

  // Stage all and commit checkpoint.
  await exec('git', ['add', '-A'], { cwd: worktreePath });
  await forgeCommit(
    worktreePath,
    composeCommitMessage(`wip(${planId}): continuation checkpoint (attempt ${info.attempt + 1})`),
  );

  let completedDiff: string;
  try {
    completedDiff = await buildContinuationDiff(worktreePath, baseBranch);
  } catch {
    completedDiff = '[Unable to generate diff]';
  }

  const nextInput: BuilderContinuationInput = {
    worktreePath,
    baseBranch,
    planId,
    builderOptions: {
      ...builderOptions,
      continuationContext: {
        attempt: info.attempt,
        maxContinuations: info.maxAttempts - 1,
        completedDiff,
      },
    },
  };
  return { kind: 'retry', input: nextInput };
}

/**
 * Shape of the evaluator input the continuation builder augments with
 * `evaluatorContinuationContext`. The `hasUnstagedChanges` short-circuit
 * runs before the context is built — callers that want to override the
 * check (e.g., in tests) can provide a custom `checkHasUnstagedChanges`.
 *
 * `planId` is optional so the same input shape serves both build-level
 * (per-plan) and compile-level (per-plan-set) evaluators. Only the build
 * evaluator's `agent:retry` event carries a planId.
 */
export interface EvaluatorContinuationInput {
  worktreePath: string;
  planId?: string;
  evaluatorOptions: Record<string, unknown> & {
    evaluatorContinuationContext?: {
      attempt: number;
      maxContinuations: number;
    };
  };
  /** Hook for tests to override the clean-worktree check. */
  checkHasUnstagedChanges?: (cwd: string) => Promise<boolean>;
}

/**
 * Build the next evaluator attempt's input:
 * - If no unstaged changes remain (all files were processed by the prior
 *   attempt), return `abort-success` — the retry short-circuits to success.
 * - Otherwise splice `evaluatorContinuationContext` into the options.
 */
export async function buildEvaluatorContinuationInput(
  info: RetryAttemptInfo<EvaluatorContinuationInput>,
): Promise<ContinuationDecision<EvaluatorContinuationInput>> {
  const { worktreePath, evaluatorOptions, checkHasUnstagedChanges } = info.prevInput;
  const check = checkHasUnstagedChanges ?? hasUnstagedChangesInternal;
  if (!(await check(worktreePath))) {
    return { kind: 'abort-success' };
  }
  const nextInput: EvaluatorContinuationInput = {
    worktreePath,
    ...(info.prevInput.planId !== undefined && { planId: info.prevInput.planId }),
    evaluatorOptions: {
      ...evaluatorOptions,
      evaluatorContinuationContext: {
        attempt: info.attempt,
        maxContinuations: info.maxAttempts - 1,
      },
    },
    checkHasUnstagedChanges,
  };
  return { kind: 'retry', input: nextInput };
}

// ---------------------------------------------------------------------------
// Default policy registry
// ---------------------------------------------------------------------------

const RETRYABLE_MAX_TURNS: ReadonlySet<AgentTerminalSubtype> = new Set(['error_max_turns']);
const EMPTY_SUBTYPES: ReadonlySet<AgentTerminalSubtype> = new Set();

/**
 * Default retry policies keyed by agent role.
 *
 * Not every `AgentRole` is registered — `getPolicy(role)` returns a
 * no-retry default for unregistered roles. Preserves the numeric values
 * previously defined in `AGENT_MAX_CONTINUATIONS_DEFAULTS`
 * (`maxAttempts = maxContinuations + 1`, i.e. 1 initial attempt plus N retries):
 *   - planner: 3 (was maxContinuations 2)
 *   - evaluator: 2 (was maxContinuations 1)
 *   - plan-evaluator / cohesion-evaluator / architecture-evaluator: 2
 *   - builder: 4 (prior default: maxContinuations 3)
 */
export const DEFAULT_RETRY_POLICIES: Partial<Record<AgentRole, RetryPolicy<unknown>>> = {
  planner: {
    agent: 'planner',
    maxAttempts: 3,
    retryableSubtypes: RETRYABLE_MAX_TURNS,
    // Only retry dropped-submission when the thrown error is actually a
    // `PlannerSubmissionError`. Inspecting events alone would also match
    // unrelated `AgentTerminalError` subtypes (e.g. `error_during_execution`,
    // `error_max_budget_usd`) that happen to have no submission tool call,
    // which the prior ad-hoc loop explicitly did not retry.
    shouldRetry: (info) => isPlannerSubmissionError(info.error) && isDroppedSubmission(info.events),
    buildContinuationInput: (info) => buildPlannerContinuationInput(info as RetryAttemptInfo<PlannerContinuationInput>) as Promise<ContinuationDecision<unknown>>,
    onRetry: (info) => {
      const reason: 'max_turns' | 'dropped_submission' =
        info.subtype === 'error_max_turns' ? 'max_turns' : 'dropped_submission';
      return [{
        timestamp: new Date().toISOString(),
        type: 'planning:continuation',
        attempt: info.attempt,
        maxContinuations: info.maxAttempts - 1,
        reason,
      }];
    },
    label: 'planner-continuation',
  },
  builder: {
    agent: 'builder',
    maxAttempts: 4,
    retryableSubtypes: RETRYABLE_MAX_TURNS,
    buildContinuationInput: (info) => buildBuilderContinuationInput(info as RetryAttemptInfo<BuilderContinuationInput>) as Promise<ContinuationDecision<unknown>>,
    onRetry: (info) => {
      const planId = (info.prevInput as BuilderContinuationInput).planId;
      return [{
        timestamp: new Date().toISOString(),
        type: 'plan:build:implement:continuation',
        planId,
        attempt: info.attempt,
        maxContinuations: info.maxAttempts - 1,
      }];
    },
    planIdFromInput: (input) => (input as BuilderContinuationInput).planId,
    label: 'builder-continuation',
  },
  evaluator: {
    agent: 'evaluator',
    maxAttempts: 2,
    retryableSubtypes: RETRYABLE_MAX_TURNS,
    buildContinuationInput: (info) => buildEvaluatorContinuationInput(info as RetryAttemptInfo<EvaluatorContinuationInput>) as Promise<ContinuationDecision<unknown>>,
    onRetry: (info) => {
      const planId = (info.prevInput as EvaluatorContinuationInput).planId ?? '';
      return [{
        timestamp: new Date().toISOString(),
        type: 'plan:build:evaluate:continuation',
        planId,
        attempt: info.attempt,
        maxContinuations: info.maxAttempts - 1,
      }];
    },
    planIdFromInput: (input) => (input as EvaluatorContinuationInput).planId,
    label: 'evaluator-continuation',
  },
  'plan-evaluator': {
    agent: 'plan-evaluator',
    maxAttempts: 2,
    retryableSubtypes: RETRYABLE_MAX_TURNS,
    buildContinuationInput: (info) => buildEvaluatorContinuationInput(info as RetryAttemptInfo<EvaluatorContinuationInput>) as Promise<ContinuationDecision<unknown>>,
    onRetry: (info) => [{
      timestamp: new Date().toISOString(),
      type: 'planning:evaluate:continuation',
      attempt: info.attempt,
      maxContinuations: info.maxAttempts - 1,
    }],
    label: 'plan-evaluator-continuation',
  },
  'cohesion-evaluator': {
    agent: 'cohesion-evaluator',
    maxAttempts: 2,
    retryableSubtypes: RETRYABLE_MAX_TURNS,
    buildContinuationInput: (info) => buildEvaluatorContinuationInput(info as RetryAttemptInfo<EvaluatorContinuationInput>) as Promise<ContinuationDecision<unknown>>,
    onRetry: (info) => [{
      timestamp: new Date().toISOString(),
      type: 'planning:cohesion:evaluate:continuation',
      attempt: info.attempt,
      maxContinuations: info.maxAttempts - 1,
    }],
    label: 'cohesion-evaluator-continuation',
  },
  'architecture-evaluator': {
    agent: 'architecture-evaluator',
    maxAttempts: 2,
    retryableSubtypes: RETRYABLE_MAX_TURNS,
    buildContinuationInput: (info) => buildEvaluatorContinuationInput(info as RetryAttemptInfo<EvaluatorContinuationInput>) as Promise<ContinuationDecision<unknown>>,
    onRetry: (info) => [{
      timestamp: new Date().toISOString(),
      type: 'planning:architecture:evaluate:continuation',
      attempt: info.attempt,
      maxContinuations: info.maxAttempts - 1,
    }],
    label: 'architecture-evaluator-continuation',
  },
};

/**
 * Look up the retry policy for a role. Returns a no-retry default for
 * roles that don't have an explicit policy registered.
 */
export function getPolicy(role: AgentRole): RetryPolicy<unknown> {
  const registered = DEFAULT_RETRY_POLICIES[role];
  if (registered) return registered;
  return {
    agent: role,
    maxAttempts: 1,
    retryableSubtypes: EMPTY_SUBTYPES,
    label: `${role}-no-retry`,
  };
}

// ---------------------------------------------------------------------------
// withRetry — the wrapper
// ---------------------------------------------------------------------------

/**
 * Classify a thrown error into an `AgentTerminalSubtype` for policy matching.
 * Returns `undefined` when the error is not one we know how to classify —
 * callers should treat `undefined` as non-retryable and rethrow.
 */
function classifyError(err: unknown): AgentTerminalSubtype | undefined {
  if (err instanceof AgentTerminalError) return err.subtype;
  if (isPlannerSubmissionError(err)) return 'error_during_execution';
  return undefined;
}

/**
 * Wrap an async-generator agent with the retry policy for its role.
 *
 * Contract:
 * - Yields every event from every attempt.
 * - When an attempt ends with a retryable terminal (thrown `AgentTerminalError`
 *   or yielded `build:failed` with `terminalSubtype`), emits an `agent:retry`
 *   event plus any policy-provided `onRetry` events, then runs the next
 *   attempt with the continuation-builder-supplied input.
 * - On `buildContinuationInput` returning `{ kind: 'abort-success' }`, stops
 *   retrying and returns normally (the held-back terminal event is dropped).
 * - On exhaustion, rethrows the captured error or yields the held-back
 *   terminal event.
 */
export async function* withRetry<Input, Result = void>(
  runAgent: (input: Input) => AsyncGenerator<EforgeEvent, Result>,
  policy: RetryPolicy<Input>,
  initialInput: Input,
): AsyncGenerator<EforgeEvent, Result | undefined> {
  let currentInput: Input = initialInput;
  let lastResult: Result | undefined;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    const attemptEvents: EforgeEvent[] = [];
    let caughtError: unknown;
    let subtype: AgentTerminalSubtype | undefined;
    let heldBackTerminal: EforgeEvent | undefined;

    const gen = runAgent(currentInput);
    try {
      let next = await gen.next();
      while (!next.done) {
        const ev = next.value;
        attemptEvents.push(ev);

        // Stream-based terminal detection: build:failed with terminalSubtype.
        if (ev.type === 'plan:build:failed' && ev.terminalSubtype) {
          subtype = ev.terminalSubtype;
          heldBackTerminal = ev;
          // Hold back — may be replaced on retry.
          next = await gen.next();
          continue;
        }

        yield ev;
        next = await gen.next();
      }
      lastResult = next.value;
    } catch (err) {
      caughtError = err;
      subtype = classifyError(err);
      if (!subtype) {
        // Non-classifiable error — bail immediately.
        throw err;
      }
    }

    // No terminal detected — normal completion.
    if (!subtype) {
      return lastResult;
    }

    const info: RetryAttemptInfo<Input> = {
      attempt,
      maxAttempts: policy.maxAttempts,
      subtype,
      events: attemptEvents,
      prevInput: currentInput,
      error: caughtError,
    };

    const inSet = policy.retryableSubtypes.has(subtype);
    const customMatch = policy.shouldRetry?.(info) ?? false;
    const canRetry = attempt < policy.maxAttempts && (inSet || customMatch);

    if (!canRetry) {
      if (caughtError !== undefined) throw caughtError;
      if (heldBackTerminal) yield heldBackTerminal;
      return lastResult;
    }

    // Build the next attempt's input. If the continuation builder throws
    // (e.g. the builder continuation aborting when the worktree has no
    // changes), treat that as "cannot retry" and propagate the original
    // terminal (held-back event or caught error) rather than the build error.
    let nextInput: Input = currentInput;
    if (policy.buildContinuationInput) {
      let decision: ContinuationDecision<Input>;
      try {
        decision = await policy.buildContinuationInput(info);
      } catch {
        if (caughtError !== undefined) throw caughtError;
        if (heldBackTerminal) yield heldBackTerminal;
        return lastResult;
      }
      if (decision.kind === 'abort-success') {
        // Drop the held-back terminal event (if any) — treat the state as
        // success.
        return lastResult;
      }
      nextInput = decision.input;
    }

    // Emit the generic agent:retry notification first.
    const planId = policy.planIdFromInput ? policy.planIdFromInput(currentInput) : undefined;
    yield {
      timestamp: new Date().toISOString(),
      type: 'agent:retry',
      agent: policy.agent,
      attempt,
      maxAttempts: policy.maxAttempts,
      subtype,
      label: policy.label,
      ...(planId !== undefined && { planId }),
    };

    // Emit any policy-specific domain continuation events (plan:continuation, etc.).
    if (policy.onRetry) {
      for (const ev of policy.onRetry(info)) {
        yield ev;
      }
    }

    currentInput = nextInput;
  }

  // Exhausted maxAttempts without a successful run. This is only reachable
  // when the final attempt is allowed to retry but has no retries left — the
  // `canRetry` guard above handles propagation, so this path is defensive.
  return lastResult;
}

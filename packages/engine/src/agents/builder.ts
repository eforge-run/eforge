import type { AgentBackend, SdkPassthroughConfig } from '../backend.js';
import { pickSdkOptions } from '../backend.js';
import { isAlwaysYieldedAgentEvent, type EforgeEvent, type PlanFile } from '../events.js';
import { loadPrompt } from '../prompts.js';
import { getEvaluationSchemaYaml } from '../schemas.js';
import { parseEvaluationBlock } from './common.js';
export type { EvaluationVerdict, EvaluationEvidence } from './common.js';

/**
 * Options for builder agent functions.
 */
export interface BuilderOptions extends SdkPassthroughConfig {
  /** Backend for running the agent */
  backend: AgentBackend;
  /** Working directory (typically a worktree path) */
  cwd: string;
  /** Stream verbose agent-level events */
  verbose?: boolean;
  /** AbortController for cancellation */
  abortController?: AbortController;
  /** Override max conversation turns (defaults: implement=50, evaluate=30) */
  maxTurns?: number;
  /** Evaluator strictness level — controls the accept/reject threshold text injected into the prompt */
  strictness?: 'strict' | 'standard' | 'lenient';
  /** Parallel stage groups from the pipeline build config — used for lane awareness */
  parallelStages?: string[][];
  /** Verification scope: 'full' runs all checks, 'build-only' skips tests (handled by test stages) */
  verificationScope?: 'full' | 'build-only';
  /** Continuation context when retrying after maxTurns exhaustion */
  continuationContext?: {
    attempt: number;
    maxContinuations: number;
    completedDiff: string;
  };
  /** Evaluator continuation context when retrying evaluator after maxTurns exhaustion */
  evaluatorContinuationContext?: {
    attempt: number;
    maxContinuations: number;
  };
  /** Commit SHA captured before the implement stage — used as evaluator reset target */
  preImplementCommit?: string;
}

/**
 * Format a parallel execution notice for the builder prompt.
 * Returns empty string when the builder is not in a parallel group.
 * When the builder runs alongside other stages, returns a notice instructing
 * it to stay in its lane (code only, no docs, use targeted `git add`).
 */
export function formatBuilderParallelNotice(parallelStages: string[][]): string {
  // Find a parallel group that contains 'implement' (the builder's stage)
  const builderGroup = parallelStages.find((group) => group.includes('implement'));
  if (!builderGroup) return '';

  const otherStages = builderGroup.filter((s) => s !== 'implement');
  if (otherStages.length === 0) return '';

  const stageList = otherStages.map((s) => `\`${s}\``).join(', ');

  return `## Parallel Execution Notice

You are running in parallel with: ${stageList}

**Stay in your lane:**
- Focus on code implementation only - do not modify documentation files (.md files in docs/, README.md, etc.)
- Use targeted \`git add <file>\` for specific files instead of \`git add -A\` or \`git add .\`
- Documentation updates are handled by a separate agent running alongside you`;
}

/**
 * Strictness text blocks injected into the evaluator prompt via {{strictness}}.
 * Exported for testability.
 */
export const STRICTNESS_BLOCKS: Record<string, string> = {
  strict: `\n### Strictness: Strict\n\nApply a high bar for acceptance. Only accept fixes that are unambiguously correct — fixing a clear bug, crash, or security vulnerability. When in doubt, reject. Treat "review" verdicts as rejects.\n`,
  standard: '',
  lenient: `\n### Strictness: Lenient\n\nApply a low bar for acceptance. Accept fixes unless they clearly damage the implementation's intent or remove functionality. When in doubt, accept. Treat "review" verdicts as accepts.\n`,
};

const VERIFICATION_FULL = `Before committing, run the verification commands specified in the plan's "Verification" section. If the plan specifies:
- Type checking (e.g., \`pnpm type-check\`) — run it and fix any errors
- Build (e.g., \`pnpm build\`) — run it and fix any errors
- Tests — run them and fix any failures

Fix any issues that arise from verification. Only proceed to commit when all verification passes.`;

const VERIFICATION_BUILD_ONLY = `Before committing, run type checking and build commands from the plan's "Verification" section:
- Type checking (e.g., \`pnpm type-check\`) — run it and fix any errors
- Build (e.g., \`pnpm build\`) — run it and fix any errors

Do NOT run tests — test verification is handled by dedicated test stages in the pipeline.

Fix any issues that arise from verification. Only proceed to commit when all verification passes.`;

/**
 * Turn 1: Implement a plan. The agent reads the plan, implements it,
 * runs verification, and commits all changes in a single commit.
 */
export async function* builderImplement(
  plan: PlanFile,
  options: BuilderOptions,
): AsyncGenerator<EforgeEvent> {
  yield { timestamp: new Date().toISOString(), type: 'build:implement:start', planId: plan.id };

  const parallelLanes = options.parallelStages
    ? formatBuilderParallelNotice(options.parallelStages)
    : '';

  const verificationScopeText = options.verificationScope === 'build-only'
    ? VERIFICATION_BUILD_ONLY
    : VERIFICATION_FULL;

  let continuationContextText = '';
  if (options.continuationContext) {
    const { attempt, maxContinuations, completedDiff } = options.continuationContext;
    continuationContextText = `## Continuation Context

**This is continuation attempt ${attempt} of ${maxContinuations}.**

The previous builder run was interrupted because it ran out of conversation turns. All progress has been committed. Do NOT redo any of the completed work shown below — pick up where it left off.

<completed_diff>
${completedDiff}
</completed_diff>

Review the diff above, then continue implementing the remaining parts of the plan. Use the Agent tool to parallelize bulk edits when many files remain.`;
  }

  const prompt = await loadPrompt('builder', {
    plan_id: plan.id,
    plan_name: plan.name,
    plan_content: plan.body,
    parallelLanes,
    verification_scope: verificationScopeText,
    continuation_context: continuationContextText,
  });

  try {
    for await (const event of options.backend.run(
      { prompt, cwd: options.cwd, maxTurns: options.maxTurns ?? 50, tools: 'coding', abortSignal: options.abortController?.signal, ...pickSdkOptions(options) },
      'builder',
      plan.id,
    )) {
      if (isAlwaysYieldedAgentEvent(event) || options.verbose) {
        yield event;
      }
    }
  } catch (err) {
    yield { timestamp: new Date().toISOString(), type: 'build:failed', planId: plan.id, error: (err as Error).message };
    return;
  }

  yield { timestamp: new Date().toISOString(), type: 'build:implement:progress', planId: plan.id, message: 'Implementation complete' };
  yield { timestamp: new Date().toISOString(), type: 'build:implement:complete', planId: plan.id };
}

/**
 * Turn 2: Evaluate reviewer's unstaged fixes. The agent runs
 * `git reset --soft <preImplementCommit>`, inspects staged (implementation)
 * vs unstaged (reviewer fixes), applies verdicts, and commits the final result.
 */
export async function* builderEvaluate(
  plan: PlanFile,
  options: BuilderOptions,
): AsyncGenerator<EforgeEvent> {
  yield { timestamp: new Date().toISOString(), type: 'build:evaluate:start', planId: plan.id };

  let continuationContextText = '';
  if (options.evaluatorContinuationContext) {
    const { attempt, maxContinuations } = options.evaluatorContinuationContext;
    continuationContextText = `## Continuation Context

**This is evaluator continuation attempt ${attempt} of ${maxContinuations}.**

The previous evaluator run was interrupted because it ran out of conversation turns. Some files have already been evaluated (accepted via \`git add\` or rejected via \`git checkout --\`). Do NOT redo already-evaluated files - only evaluate files that still have unstaged changes.

Do NOT run \`git reset --soft ${options.preImplementCommit ?? 'HEAD~1'}\` again - the staged vs unstaged comparison is already set up from the previous run.`;
  }

  const strictnessKey = options.strictness ?? 'standard';
  const prompt = await loadPrompt('evaluator', {
    plan_id: plan.id,
    plan_name: plan.name,
    strictness: STRICTNESS_BLOCKS[strictnessKey] ?? '',
    evaluation_schema: getEvaluationSchemaYaml(),
    continuation_context: continuationContextText,
    reset_target: options.preImplementCommit ?? 'HEAD~1',
  });

  let fullText = '';
  try {
    for await (const event of options.backend.run(
      { prompt, cwd: options.cwd, maxTurns: options.maxTurns ?? 30, tools: 'coding', abortSignal: options.abortController?.signal, ...pickSdkOptions(options) },
      'evaluator',
      plan.id,
    )) {
      if (isAlwaysYieldedAgentEvent(event) || options.verbose) {
        yield event;
      }
      if (event.type === 'agent:message' && event.content) {
        fullText += event.content;
      }
    }
  } catch (err) {
    // Re-throw error_max_turns to enable pipeline continuation loop
    if ((err as Error).message.includes('error_max_turns')) {
      throw err;
    }
    yield { timestamp: new Date().toISOString(), type: 'build:failed', planId: plan.id, error: (err as Error).message };
    return;
  }

  const verdicts = parseEvaluationBlock(fullText);
  const accepted = verdicts.filter((v) => v.action === 'accept').length;
  const rejected = verdicts.filter((v) => v.action === 'reject' || v.action === 'review').length;

  yield { timestamp: new Date().toISOString(), type: 'build:evaluate:complete', planId: plan.id, accepted, rejected, verdicts: verdicts.map(v => ({ file: v.file, action: v.action, reason: v.reason })) };
}


import { execFile } from 'node:child_process';
import { posix } from 'node:path';
import { promisify } from 'node:util';

import type { AgentHarness, SdkPassthroughConfig } from '../harness.js';
import { pickSdkOptions } from '../harness.js';
import { isAlwaysYieldedAgentEvent, type EforgeEvent } from '../events.js';
import { loadPrompt } from '../prompts.js';
import { getEvaluationSchemaYaml, getEvaluationSubmissionSchemaYaml, type EvaluationSubmission, type EvaluationVerdict } from '../schemas.js';
import {
  applyEvaluationVerdicts,
  assertNoEvaluationDrift,
  createEvaluationTools,
  discardEvaluationCandidateFixes,
  restoreEvaluationSnapshotAfterFailure,
  validateEvaluationPath,
  type EvaluationSnapshot,
} from '../evaluation/index.js';
import type { ModelTracker } from '../model-tracker.js';
import { parseEvaluationBlock } from './common.js';

const exec = promisify(execFile);

/**
 * Evaluator mode: 'plan' for plan review evaluation, 'cohesion' for cohesion review evaluation.
 */
export type EvaluatorMode = 'plan' | 'cohesion' | 'architecture';

/**
 * Options shared by plan, cohesion, and architecture evaluator agents.
 */
export interface PlanPhaseEvaluatorOptions extends SdkPassthroughConfig {
  /** Evaluator mode */
  mode: EvaluatorMode;
  /** Harness for running the agent */
  harness: AgentHarness;
  /** The plan set name */
  planSetName: string;
  /** The original source/PRD content for context */
  sourceContent: string;
  /** Working directory */
  cwd: string;
  /** Whether to emit verbose agent-level events */
  verbose?: boolean;
  /** AbortController for cancellation */
  abortController?: AbortController;
  /** Plan output directory (defaults to 'eforge/plans'). */
  outputDir?: string;
  /** Immutable candidate snapshot captured by the engine before evaluation. */
  evaluationSnapshot?: EvaluationSnapshot;
  /** Commit message body for accepted compile evaluator fixes. */
  commitMessage?: string;
  /** Optional model tracker for Models-Used commit trailers. */
  modelTracker?: ModelTracker;
  /** Repository-relative directory prefix that all evaluator verdict paths must stay within. */
  allowedPathPrefix?: string;
  /** Continuation context when retrying after maxTurns exhaustion */
  continuationContext?: {
    attempt: number;
    maxContinuations: number;
  };
}

/**
 * Options for the plan evaluator agent.
 */
export interface PlanEvaluatorOptions extends SdkPassthroughConfig {
  /** Harness for running the agent */
  harness: AgentHarness;
  /** The plan set name */
  planSetName: string;
  /** The original source/PRD content for context */
  sourceContent: string;
  /** Working directory */
  cwd: string;
  /** Whether to emit verbose agent-level events */
  verbose?: boolean;
  /** AbortController for cancellation */
  abortController?: AbortController;
  /** Plan output directory (defaults to 'eforge/plans'). */
  outputDir?: string;
  /** Immutable candidate snapshot captured by the engine before evaluation. */
  evaluationSnapshot?: EvaluationSnapshot;
  /** Commit message body for accepted compile evaluator fixes. */
  commitMessage?: string;
  /** Optional model tracker for Models-Used commit trailers. */
  modelTracker?: ModelTracker;
  /** Repository-relative directory prefix that all evaluator verdict paths must stay within. */
  allowedPathPrefix?: string;
  /** Continuation context when retrying after maxTurns exhaustion */
  continuationContext?: {
    attempt: number;
    maxContinuations: number;
  };
}

/**
 * Options for the cohesion evaluator agent.
 */
export type CohesionEvaluatorOptions = PlanEvaluatorOptions;

/**
 * Options for the architecture evaluator agent.
 */
export type ArchitectureEvaluatorOptions = PlanEvaluatorOptions;

// Mode-specific configuration
const MODE_CONFIG = {
  plan: {
    startEvent: 'planning:evaluate:start' as const,
    completeEvent: 'planning:evaluate:complete' as const,
    promptName: 'plan-evaluator',
    role: 'plan-evaluator' as const,
    promptVars: {
      evaluator_title: 'Plan Fix Evaluator',
      evaluator_context: 'A planner agent generated plan files and committed them. A blind plan reviewer then reviewed the plan files and left fixes as captured candidate changes. You must evaluate each fix and decide whether to accept, reject, or flag for review.',
      strict_improvement_bullet_1: 'It fixes a genuine, objective issue (missing dependency, incorrect file path, coverage gap, contradictory scope)',
      accept_patterns_table: `| Missing dependency | Plan B uses types from Plan A but doesn't list A in \`depends_on\` |
| Incorrect file path | Plan references \`src/utils/helper.ts\` but file is at \`src/lib/helper.ts\` |
| Missing PRD coverage | Source requires auth but no plan covers it — reviewer adds coverage note |
| Branch name mismatch | YAML frontmatter \`branch\` doesn't match orchestration.yaml |
| Incorrect plan ID reference | \`depends_on\` references a plan ID that doesn't exist |
| Missing verification step | Plan has no way to verify its own implementation |`,
      reject_criteria_extra: '',
    },
  },
  cohesion: {
    startEvent: 'planning:cohesion:evaluate:start' as const,
    completeEvent: 'planning:cohesion:evaluate:complete' as const,
    promptName: 'plan-evaluator',
    role: 'cohesion-evaluator' as const,
    promptVars: {
      evaluator_title: 'Cohesion Fix Evaluator',
      evaluator_context: 'A planner agent generated module plans and committed them. A blind cohesion reviewer then reviewed the module plans for cross-module issues (file overlaps, integration contracts, dependency errors, vague criteria) and left fixes as captured candidate changes. You must evaluate each fix and decide whether to accept, reject, or flag for review.',
      strict_improvement_bullet_1: 'It fixes a genuine, objective issue (missing dependency, file overlap conflict, uncovered integration contract, vague criterion)',
      accept_patterns_table: `| Missing dependency | Plan B modifies a file that Plan A creates but doesn't list A in \`depends_on\` |
| Vague criterion fix | "Tests pass properly" → "\`pnpm test\` exits with code 0" |
| Integration gap | Architecture defines a contract but no plan covers the consumer side |
| File overlap resolution | Two plans modify same file — reviewer adds dependency to sequence them |
| Incorrect plan ID | \`depends_on\` references a plan ID that doesn't exist |`,
      reject_criteria_extra: '\n4. **Module boundary change** — The change alters module boundaries from the architecture',
    },
  },
  architecture: {
    startEvent: 'planning:architecture:evaluate:start' as const,
    completeEvent: 'planning:architecture:evaluate:complete' as const,
    promptName: 'plan-evaluator',
    role: 'architecture-evaluator' as const,
    promptVars: {
      evaluator_title: 'Architecture Fix Evaluator',
      evaluator_context: 'A planner agent generated an architecture document and committed it. A blind architecture reviewer then reviewed the architecture against the PRD for module boundary soundness, integration contract completeness, and feasibility — and left fixes as captured candidate changes. You must evaluate each fix and decide whether to accept, reject, or flag for review.',
      strict_improvement_bullet_1: 'It fixes a genuine, objective issue (unclear module boundary clarified, missing integration contract added, shared file registry gap filled)',
      accept_patterns_table: `| Unclear module boundary | Module boundary description was vague — reviewer clarified scope |
| Missing integration contract | Two modules interact but no contract was defined — reviewer added one |
| Shared file registry gap | A file is shared across modules but not listed in the registry |
| Data model inconsistency | Architecture references a type not defined in any module |
| PRD alignment gap | Architecture omits a requirement from the PRD |`,
      reject_criteria_extra: '\n4. **Module decomposition change** — The change alters the module decomposition strategy from the planner',
    },
  },
} as const;

const EVALUATOR_MUTATION_TOOL_DENYLIST = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash'] as const;

function mergeDisallowedTools(existing: string[] | undefined): string[] {
  return Array.from(new Set([...(existing ?? []), ...EVALUATOR_MUTATION_TOOL_DENYLIST]));
}

function summarizeEvaluationVerdicts(verdicts: EvaluationVerdict[]) {
  return verdicts.map(v => ({
    file: v.file,
    action: v.action,
    reason: v.reason,
    ...(v.hunk !== undefined && { hunk: v.hunk }),
  }));
}

function normalizePathPrefix(prefix: string): string {
  const normalized = validateEvaluationPath(prefix);
  return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

function isWithinPrefix(file: string, prefix: string): boolean {
  return file === prefix || file.startsWith(`${prefix}/`);
}

function validatePathGuard(
  verdicts: EvaluationVerdict[],
  allowedPathPrefix: string | undefined,
  snapshot?: EvaluationSnapshot,
): void {
  if (!allowedPathPrefix) return;
  const prefix = normalizePathPrefix(allowedPathPrefix);
  const candidates = new Map(snapshot?.files.map(file => [file.path, file]) ?? []);
  for (const verdict of verdicts) {
    const file = validateEvaluationPath(verdict.file);
    const candidate = candidates.get(file);
    const oldPath = candidate?.oldPath ? validateEvaluationPath(candidate.oldPath) : undefined;
    const guardedPaths = oldPath && oldPath !== file
      ? [file, oldPath]
      : [file];
    for (const guardedPath of guardedPaths) {
      if (!isWithinPrefix(guardedPath, prefix)) {
        throw new Error(`Evaluation verdict path is outside the allowed planning artifact directory (${prefix}): ${guardedPath}`);
      }
    }
  }
}

async function restoreOriginalEvaluationHead(snapshot: EvaluationSnapshot): Promise<void> {
  await restoreEvaluationSnapshotAfterFailure(snapshot);
  await discardEvaluationCandidateFixes(snapshot);
  await exec('git', ['reset', '--hard', snapshot.originalHead ?? snapshot.baseHead], { cwd: snapshot.cwd });
}

async function restoreIfSnapshotClean(snapshot: EvaluationSnapshot): Promise<void> {
  await assertNoEvaluationDrift(snapshot);
  await restoreOriginalEvaluationHead(snapshot);
}

function planningError(reason: string): EforgeEvent {
  return { timestamp: new Date().toISOString(), type: 'planning:error', reason };
}

/**
 * Internal consolidated evaluator runner for plan, cohesion, and architecture evaluation.
 *
 * Yields:
 * - Mode-specific start event at the beginning
 * - `agent:message`, `agent:tool_use`, `agent:tool_result` events (when verbose)
 * - Mode-specific complete event with accepted/rejected counts at the end
 */
async function* runEvaluate(
  options: PlanPhaseEvaluatorOptions,
): AsyncGenerator<EforgeEvent> {
  const { mode, harness, planSetName, sourceContent, cwd, verbose, abortController } = options;
  const config = MODE_CONFIG[mode];

  yield { timestamp: new Date().toISOString(), type: config.startEvent };

  let continuationContextText = '';
  if (options.continuationContext) {
    const { attempt, maxContinuations } = options.continuationContext;
    continuationContextText = `## Continuation Context

**This is evaluator continuation attempt ${attempt} of ${maxContinuations}.**

The previous evaluator run was interrupted before a final verdict submission was accepted. The engine is reusing the same immutable evaluation snapshot. Do not assume any partial file application happened; re-inspect the captured diff and submit one complete verdict set covering every candidate file or hunk.`;
  }

  let structuredSubmission: EvaluationSubmission | undefined;
  const customTools = options.evaluationSnapshot
    ? createEvaluationTools(options.evaluationSnapshot, (submission) => {
      if (structuredSubmission) return false;
      structuredSubmission = submission;
    })
    : undefined;

  const prompt = await loadPrompt(config.promptName, {
    plan_set_name: planSetName,
    source_content: sourceContent,
    evaluation_schema: getEvaluationSchemaYaml(),
    evaluation_submission_schema: getEvaluationSubmissionSchemaYaml(),
    outputDir: options.outputDir ?? 'eforge/plans',
    continuation_context: continuationContextText,
    list_files_tool: harness.effectiveCustomToolName('list_evaluation_files'),
    get_diff_tool: harness.effectiveCustomToolName('get_evaluation_diff'),
    submit_verdicts_tool: harness.effectiveCustomToolName('submit_evaluation_verdicts'),
    ...config.promptVars,
  }, options.promptAppend);

  let fullText = '';
  let toolValidationError: string | undefined;
  const submitToolName = harness.effectiveCustomToolName('submit_evaluation_verdicts');
  const disallowedTools = mergeDisallowedTools(options.disallowedTools);
  try {
    for await (const event of harness.run(
      {
        prompt,
        cwd,
        maxTurns: 30,
        tools: 'coding',
        customTools,
        disallowedTools,
        abortSignal: abortController?.signal,
        ...pickSdkOptions({ ...options, disallowedTools }),
      },
      config.role,
    )) {
      if (isAlwaysYieldedAgentEvent(event) || verbose) {
        yield event;
      }
      if (event.type === 'agent:message' && event.content) {
        fullText += event.content;
      }
      if (
        event.type === 'agent:tool_result' &&
        (event.tool === submitToolName || event.tool === 'submit_evaluation_verdicts') &&
        typeof event.output === 'string' &&
        event.output.startsWith('Evaluation submission rejected:')
      ) {
        toolValidationError = event.output;
      }
      if (event.type === 'agent:result' && event.result.resultText && !fullText.includes(event.result.resultText)) {
        fullText += event.result.resultText;
      }
    }
  } catch (err) {
    yield { timestamp: new Date().toISOString(), type: config.completeEvent, accepted: 0, rejected: 0, verdicts: [] };
    throw err;
  }

  const verdicts = structuredSubmission?.verdicts ?? parseEvaluationBlock(fullText);

  if (!options.evaluationSnapshot) {
    const accepted = verdicts.filter((v) => v.action === 'accept').length;
    const rejected = verdicts.filter((v) => v.action === 'reject' || v.action === 'review').length;
    yield { timestamp: new Date().toISOString(), type: config.completeEvent, accepted, rejected, verdicts: summarizeEvaluationVerdicts(verdicts) };
    return;
  }

  if (verdicts.length === 0) {
    try {
      await restoreIfSnapshotClean(options.evaluationSnapshot);
    } catch (err) {
      try {
        await restoreOriginalEvaluationHead(options.evaluationSnapshot);
      } catch {
        // Preserve the deterministic drift error in the emitted planning:error.
      }
      yield planningError(err instanceof Error ? err.message : String(err));
      return;
    }
    if (toolValidationError) {
      yield planningError(toolValidationError.split('\n')[0] ?? toolValidationError);
      return;
    }
    yield { timestamp: new Date().toISOString(), type: config.completeEvent, accepted: 0, rejected: 0, verdicts: [] };
    return;
  }

  try {
    validatePathGuard(
      verdicts,
      options.allowedPathPrefix ?? posix.join(options.outputDir ?? 'eforge/plans', planSetName),
      options.evaluationSnapshot,
    );
    const application = await applyEvaluationVerdicts(options.evaluationSnapshot, verdicts, {
      commitMessage: options.commitMessage ?? `plan(${planSetName}): planning artifacts`,
      modelTracker: options.modelTracker,
    });
    yield {
      timestamp: new Date().toISOString(),
      type: config.completeEvent,
      accepted: application.accepted,
      rejected: application.rejected,
      verdicts: summarizeEvaluationVerdicts(verdicts),
    };
  } catch (err) {
    try {
      await restoreOriginalEvaluationHead(options.evaluationSnapshot);
    } catch {
      // Preserve the deterministic application failure as the planning error.
    }
    yield planningError(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Evaluate the plan reviewer's captured fixes. The engine owns snapshot
 * preparation, verdict application, cleanup, and committing.
 *
 * Yields:
 * - `planning:evaluate:start` at the beginning
 * - `agent:message`, `agent:tool_use`, `agent:tool_result` events (when verbose)
 * - `planning:evaluate:complete` with accepted/rejected counts at the end
 */
export async function* runPlanEvaluate(
  options: PlanEvaluatorOptions,
): AsyncGenerator<EforgeEvent> {
  yield* runEvaluate({ ...options, mode: 'plan' });
}

/**
 * Evaluate the cohesion reviewer's captured fixes. The engine owns snapshot
 * preparation, verdict application, cleanup, and committing.
 *
 * Yields:
 * - `planning:cohesion:evaluate:start` at the beginning
 * - `agent:message`, `agent:tool_use`, `agent:tool_result` events (when verbose)
 * - `planning:cohesion:evaluate:complete` with accepted/rejected counts at the end
 */
export async function* runCohesionEvaluate(
  options: CohesionEvaluatorOptions,
): AsyncGenerator<EforgeEvent> {
  yield* runEvaluate({ ...options, mode: 'cohesion' });
}

/**
 * Evaluate the architecture reviewer's captured fixes. The engine owns snapshot
 * preparation, verdict application, cleanup, and committing.
 *
 * Yields:
 * - `planning:architecture:evaluate:start` at the beginning
 * - `agent:message`, `agent:tool_use`, `agent:tool_result` events (when verbose)
 * - `planning:architecture:evaluate:complete` with accepted/rejected counts at the end
 */
export async function* runArchitectureEvaluate(
  options: ArchitectureEvaluatorOptions,
): AsyncGenerator<EforgeEvent> {
  yield* runEvaluate({ ...options, mode: 'architecture' });
}

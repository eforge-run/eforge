import type { AgentBackend, SdkPassthroughConfig } from '../backend.js';
import { pickSdkOptions } from '../backend.js';
import { isAlwaysYieldedAgentEvent, type EforgeEvent } from '../events.js';
import { loadPrompt } from '../prompts.js';
import { getEvaluationSchemaYaml } from '../schemas.js';
import { parseEvaluationBlock } from './common.js';

/**
 * Evaluator mode: 'plan' for plan review evaluation, 'cohesion' for cohesion review evaluation.
 */
export type EvaluatorMode = 'plan' | 'cohesion' | 'architecture';

/**
 * Options shared by both plan and cohesion evaluator agents.
 */
export interface PlanPhaseEvaluatorOptions extends SdkPassthroughConfig {
  /** Evaluator mode */
  mode: EvaluatorMode;
  /** Backend for running the agent */
  backend: AgentBackend;
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
}

/**
 * Options for the plan evaluator agent.
 */
export interface PlanEvaluatorOptions extends SdkPassthroughConfig {
  /** Backend for running the agent */
  backend: AgentBackend;
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
    startEvent: 'plan:evaluate:start' as const,
    completeEvent: 'plan:evaluate:complete' as const,
    promptName: 'plan-evaluator',
    role: 'plan-evaluator' as const,
    promptVars: {
      evaluator_title: 'Plan Fix Evaluator',
      evaluator_context: 'A planner agent generated plan files and committed them. A blind plan reviewer then reviewed the plan files and left fixes as unstaged changes. You must evaluate each fix and decide whether to accept, reject, or flag for review.',
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
    startEvent: 'plan:cohesion:evaluate:start' as const,
    completeEvent: 'plan:cohesion:evaluate:complete' as const,
    promptName: 'plan-evaluator',
    role: 'cohesion-evaluator' as const,
    promptVars: {
      evaluator_title: 'Cohesion Fix Evaluator',
      evaluator_context: 'A planner agent generated module plans and committed them. A blind cohesion reviewer then reviewed the module plans for cross-module issues (file overlaps, integration contracts, dependency errors, vague criteria) and left fixes as unstaged changes. You must evaluate each fix and decide whether to accept, reject, or flag for review.',
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
    startEvent: 'plan:architecture:evaluate:start' as const,
    completeEvent: 'plan:architecture:evaluate:complete' as const,
    promptName: 'plan-evaluator',
    role: 'architecture-evaluator' as const,
    promptVars: {
      evaluator_title: 'Architecture Fix Evaluator',
      evaluator_context: 'A planner agent generated an architecture document and committed it. A blind architecture reviewer then reviewed the architecture against the PRD for module boundary soundness, integration contract completeness, and feasibility — and left fixes as unstaged changes. You must evaluate each fix and decide whether to accept, reject, or flag for review.',
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
  const { mode, backend, planSetName, sourceContent, cwd, verbose, abortController } = options;
  const config = MODE_CONFIG[mode];

  yield { timestamp: new Date().toISOString(), type: config.startEvent };

  const prompt = await loadPrompt(config.promptName, {
    plan_set_name: planSetName,
    source_content: sourceContent,
    evaluation_schema: getEvaluationSchemaYaml(),
    outputDir: options.outputDir ?? 'eforge/plans',
    ...config.promptVars,
  });

  let fullText = '';
  try {
    for await (const event of backend.run(
      { prompt, cwd, maxTurns: 30, tools: 'coding', abortSignal: abortController?.signal, ...pickSdkOptions(options) },
      config.role,
    )) {
      if (isAlwaysYieldedAgentEvent(event) || verbose) {
        yield event;
      }
      if (event.type === 'agent:message' && event.content) {
        fullText += event.content;
      }
    }
  } catch (err) {
    yield { timestamp: new Date().toISOString(), type: config.completeEvent, accepted: 0, rejected: 0, verdicts: [] };
    throw err;
  }

  const verdicts = parseEvaluationBlock(fullText);
  const accepted = verdicts.filter((v) => v.action === 'accept').length;
  const rejected = verdicts.filter((v) => v.action === 'reject' || v.action === 'review').length;

  yield { timestamp: new Date().toISOString(), type: config.completeEvent, accepted, rejected, verdicts: verdicts.map(v => ({ file: v.file, action: v.action, reason: v.reason })) };
}

/**
 * Evaluate the plan reviewer's unstaged fixes. Runs `git reset --soft HEAD~1`
 * to expose staged (planner's plans) vs unstaged (reviewer's fixes), applies
 * verdicts, and commits the final result.
 *
 * Yields:
 * - `plan:evaluate:start` at the beginning
 * - `agent:message`, `agent:tool_use`, `agent:tool_result` events (when verbose)
 * - `plan:evaluate:complete` with accepted/rejected counts at the end
 */
export async function* runPlanEvaluate(
  options: PlanEvaluatorOptions,
): AsyncGenerator<EforgeEvent> {
  yield* runEvaluate({ ...options, mode: 'plan' });
}

/**
 * Evaluate the cohesion reviewer's unstaged fixes. Runs `git reset --soft HEAD~1`
 * to expose staged (planner's plans) vs unstaged (reviewer's fixes), applies
 * verdicts, and commits the final result.
 *
 * Yields:
 * - `plan:cohesion:evaluate:start` at the beginning
 * - `agent:message`, `agent:tool_use`, `agent:tool_result` events (when verbose)
 * - `plan:cohesion:evaluate:complete` with accepted/rejected counts at the end
 */
export async function* runCohesionEvaluate(
  options: CohesionEvaluatorOptions,
): AsyncGenerator<EforgeEvent> {
  yield* runEvaluate({ ...options, mode: 'cohesion' });
}

/**
 * Evaluate the architecture reviewer's unstaged fixes. Runs `git reset --soft HEAD~1`
 * to expose staged (planner's architecture) vs unstaged (reviewer's fixes), applies
 * verdicts, and commits the final result.
 *
 * Yields:
 * - `plan:architecture:evaluate:start` at the beginning
 * - `agent:message`, `agent:tool_use`, `agent:tool_result` events (when verbose)
 * - `plan:architecture:evaluate:complete` with accepted/rejected counts at the end
 */
export async function* runArchitectureEvaluate(
  options: ArchitectureEvaluatorOptions,
): AsyncGenerator<EforgeEvent> {
  yield* runEvaluate({ ...options, mode: 'architecture' });
}

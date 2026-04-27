import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AgentHarness, SdkPassthroughConfig, CustomTool } from '../harness.js';
import { pickSdkOptions, PlannerSubmissionError } from '../harness.js';
import { isAlwaysYieldedAgentEvent, type EforgeEvent, type CompileOptions, type ClarificationQuestion, type PlanFile } from '../events.js';
import { parseClarificationBlocks, parseSkipBlock } from './common.js';
import { loadPrompt } from '../prompts.js';
import { deriveNameFromSource, extractPlanTitle, parsePlanFile, writePlanSet, writeArchitecture } from '../plan.js';
import {
  getClarificationSchemaYaml, getModuleSchemaYaml, getPlanFrontmatterSchemaYaml,
  planSetSubmissionSchema, architectureSubmissionSchema,
  type PlanSetSubmission, type ArchitectureSubmission,
} from '../schemas.js';

export interface PlannerOptions extends CompileOptions, SdkPassthroughConfig {
  harness: AgentHarness;
  onClarification?: (questions: ClarificationQuestion[]) => Promise<Record<string, string>>;
  /** Pre-determined scope from the pipeline composer (errand/excursion/expedition) */
  scope?: string;
  /** Override max conversation turns (default: 30) */
  maxTurns?: number;
  /** Continuation context when restarting after hitting max turns or a dropped submission. */
  continuationContext?: { attempt: number; maxContinuations: number; existingPlans: string; reason: 'max_turns' | 'dropped_submission' };
  /** Plan output directory (defaults to 'eforge/plans'). */
  outputDir?: string;
}

/**
 * Format accumulated clarification Q&A into a prompt section for retry.
 * Returns empty string when there are no prior clarifications.
 */
export function formatPriorClarifications(
  allClarifications: Array<{ questions: ClarificationQuestion[]; answers: Record<string, string> }>,
): string {
  const rows: string[] = [];
  for (const { questions, answers } of allClarifications) {
    for (const q of questions) {
      if (answers[q.id] !== undefined) {
        const escapedQ = q.question.replaceAll('|', '\\|');
        const escapedA = answers[q.id].replaceAll('|', '\\|');
        rows.push(`| ${q.id}: ${escapedQ} | ${escapedA} |`);
      }
    }
  }

  if (rows.length === 0) return '';

  return `## Prior Clarifications

You previously asked the following clarifying questions and received answers. Use these answers directly. Do NOT re-ask these questions or ask for further clarification on topics already covered below.

| Question | Answer |
|----------|--------|
${rows.join('\n')}`;
}

/**
 * Format zod validation issues into a retry-oriented error message.
 *
 * The previous `Validation error: ${result.error.message}` served up a raw
 * JSON-stringified issues array, which models read as "the tool is broken"
 * and abandon in favor of Write. An explicit per-path breakdown plus an
 * explicit "call the tool again" instruction flips that behavior to a retry.
 */
function formatSubmissionValidationError(issues: readonly { path: readonly (string | number | symbol)[]; message: string }[]): string {
  const lines = issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)';
    return `  - ${path}: ${issue.message}`;
  });
  return [
    'Submission rejected: the payload did not validate against the schema.',
    'Fix each issue below and call the submission tool again with the corrected payload.',
    'Do NOT fall back to Write - this tool is the only way to complete the turn.',
    '',
    ...lines,
  ].join('\n');
}

/**
 * Create a custom tool for submitting a plan set (errand/excursion mode).
 * The handler validates the payload against the schema and captures it via the callback.
 */
function createPlanSetSubmissionTool(
  onSubmit: (payload: PlanSetSubmission) => boolean,
): CustomTool {
  return {
    name: 'submit_plan_set',
    description: 'Submit a complete plan set with all plan files and orchestration configuration. This is the only way to complete the planning turn for errand/excursion mode.',
    inputSchema: planSetSubmissionSchema,
    handler: async (input: unknown) => {
      const result = planSetSubmissionSchema.safeParse(input);
      if (!result.success) {
        return formatSubmissionValidationError(result.error.issues);
      }
      if (!onSubmit(result.data)) {
        return 'Error: a submission tool was already called. Only one submission per planning turn is allowed.';
      }
      return 'Plan set submitted successfully.';
    },
  };
}

/**
 * Create a custom tool for submitting an architecture (expedition mode).
 * The handler validates the payload against the schema and captures it via the callback.
 */
function createArchitectureSubmissionTool(
  onSubmit: (payload: ArchitectureSubmission) => boolean,
): CustomTool {
  return {
    name: 'submit_architecture',
    description: 'Submit architecture documentation and module definitions for an expedition. This is the only way to complete the planning turn for expedition mode.',
    inputSchema: architectureSubmissionSchema,
    handler: async (input: unknown) => {
      const result = architectureSubmissionSchema.safeParse(input);
      if (!result.success) {
        return formatSubmissionValidationError(result.error.issues);
      }
      if (!onSubmit(result.data)) {
        return 'Error: a submission tool was already called. Only one submission per planning turn is allowed.';
      }
      return 'Architecture submitted successfully.';
    },
  };
}

/**
 * Run the planner agent. Explores the codebase, asks clarifying questions
 * via <clarification> XML blocks, and writes plan files to disk.
 *
 * Clarification flow: when the agent emits <clarification> blocks,
 * the planner pauses, collects answers via onClarification callback,
 * bakes answers into the prompt, and restarts the agent.
 *
 * @param source - PRD file path or inline prompt string
 * @param options - Planner configuration
 * @yields EforgeEvent stream
 */
export async function* runPlanner(
  source: string,
  options: PlannerOptions,
): AsyncGenerator<EforgeEvent> {
  const cwd = options.cwd ?? process.cwd();
  const { harness } = options;

  // Resolve source: file path → read contents, otherwise use as inline string
  let sourceContent: string;
  try {
    const sourcePath = resolve(cwd, source);
    const stats = await stat(sourcePath);
    if (stats.isFile()) {
      sourceContent = await readFile(sourcePath, 'utf-8');
    } else {
      sourceContent = source;
    }
  } catch {
    sourceContent = source;
  }

  // Derive plan set name from options or source
  const planSetName = options.name ?? deriveNameFromSource(source);

  const sourceLabel = extractPlanTitle(source)
    ?? (source.includes('\n') ? source.split('\n')[0].slice(0, 80) : undefined);
  yield { timestamp: new Date().toISOString(), type: 'planning:start', source, ...(sourceLabel && { label: sourceLabel }) };
  yield { timestamp: new Date().toISOString(), type: 'planning:progress', message: 'Loading planner prompt...' };

  // Track clarification Q&A across iterations
  const allClarifications: Array<{ questions: ClarificationQuestion[]; answers: Record<string, string> }> = [];

  function buildPrompt(): Promise<string> {
    // Resolve the backend-visible name for the submission tool(s) currently
    // injected into this planner run. The planner prompt uses `{{submitTool}}`
    // placeholders; each backend maps the bare `CustomTool.name` to the name
    // the model will actually see (e.g. the Claude SDK prepends its
    // in-process MCP-server prefix, Pi uses the bare name). When both tools
    // are injected (unknown scope), list both names joined by " or " so the
    // prompt still names the exact per-backend identifiers.
    const effectiveNames = customTools.map(t => harness.effectiveCustomToolName(t.name));
    const submitTool = effectiveNames.join(' or ');

    let continuationContextText = '';
    if (options.continuationContext) {
      const { attempt, maxContinuations, existingPlans, reason } = options.continuationContext;
      if (reason === 'dropped_submission') {
        continuationContextText = `## Continuation Context

This is continuation attempt ${attempt} of ${maxContinuations}. The previous attempt completed reasoning but did not call ${submitTool}. You MUST call ${submitTool} with your final plan set to complete this run — reasoning alone does not submit plans.`;
      } else {
        continuationContextText = `## Continuation Context

This is continuation attempt ${attempt} of ${maxContinuations}. The planner hit the max turns limit on the previous attempt. The following plan files have already been written. Do NOT redo any of the completed work below.

### Existing Plans

${existingPlans}`;
      }
    }

    return loadPrompt('planner', {
      source: sourceContent,
      planSetName,
      cwd,
      outputDir: options.outputDir ?? 'eforge/plans',
      priorClarifications: formatPriorClarifications(allClarifications),
      continuation_context: continuationContextText,
      scope: options.scope ?? '',
      parallelLanes: '',
      profiles: '',
      profileGeneration: '',
      clarification_schema: getClarificationSchemaYaml(),
      module_schema: getModuleSchemaYaml(),
      plan_frontmatter_schema: getPlanFrontmatterSchemaYaml(),
      submitTool,
    }, options.promptAppend);
  }

  let skipEmitted = false;

  // Mutable container for submission payloads — set by custom tool handlers via closure
  const captured: { planSet: PlanSetSubmission | null; architecture: ArchitectureSubmission | null } = {
    planSet: null,
    architecture: null,
  };

  // Create submission tools based on scope
  const customTools: CustomTool[] = [];
  const scope = options.scope;

  const alreadySubmitted = () => captured.planSet !== null || captured.architecture !== null;

  if (scope === 'expedition') {
    customTools.push(createArchitectureSubmissionTool((payload) => { if (alreadySubmitted()) return false; captured.architecture = payload; return true; }));
  } else if (scope === 'errand' || scope === 'excursion') {
    customTools.push(createPlanSetSubmissionTool((payload) => { if (alreadySubmitted()) return false; captured.planSet = payload; return true; }));
  } else {
    // Unknown scope (no pipeline composer) — inject both tools, let the agent choose
    customTools.push(createPlanSetSubmissionTool((payload) => { if (alreadySubmitted()) return false; captured.planSet = payload; return true; }));
    customTools.push(createArchitectureSubmissionTool((payload) => { if (alreadySubmitted()) return false; captured.architecture = payload; return true; }));
  }

  // Main loop: run agent, collect clarifications, restart with answers baked in
  let iteration = 0;
  const maxIterations = 5; // prevent infinite loops

  while (iteration < maxIterations) {
    iteration++;

    const prompt = await buildPrompt();

    if (iteration === 1) {
      yield { timestamp: new Date().toISOString(), type: 'planning:progress', message: 'Starting planner agent...' };
    } else {
      yield { timestamp: new Date().toISOString(), type: 'planning:progress', message: 'Planner restarted with prior clarifications' };
    }

    let needsRestart = false;

    for await (const event of harness.run(
      { prompt, cwd, maxTurns: options.maxTurns ?? 30, tools: 'coding', abortSignal: options.abortController?.signal, customTools, ...pickSdkOptions(options) },
      'planner',
    )) {
      if (event.type === 'agent:message') {
        if (!skipEmitted) {
          const skipReason = parseSkipBlock(event.content);
          if (skipReason) {
            skipEmitted = true;
            yield { timestamp: new Date().toISOString(), type: 'planning:skip', reason: skipReason };
          }
        }

        const questions = parseClarificationBlocks(event.content);
        if (questions.length > 0 && !options.auto) {
          yield { timestamp: new Date().toISOString(), type: 'planning:clarification', questions };

          if (options.onClarification) {
            const answers = await options.onClarification(questions);
            yield { timestamp: new Date().toISOString(), type: 'planning:clarification:answer', answers };
            allClarifications.push({ questions, answers });
            // Restart agent with answers baked into prompt
            needsRestart = true;
            break;
          }
        }
      }

      // Always yield agent:result + tool events (for tracing); gate streaming text on verbose
      if (isAlwaysYieldedAgentEvent(event) || options.verbose) {
        yield event;
      }
    }

    if (!needsRestart) break;
  }

  // Skip was emitted — no plans to write
  if (skipEmitted) return;

  const outputDir = options.outputDir ?? 'eforge/plans';

  // Handle plan set submission
  if (captured.planSet) {
    const planSetPayload = captured.planSet;
    yield {
      timestamp: new Date().toISOString(),
      type: 'planning:submission',
      planCount: planSetPayload.plans.length,
      totalBodySize: planSetPayload.plans.reduce((sum: number, p) => sum + p.body.length, 0),
      hasMigrations: planSetPayload.plans.some(p => p.frontmatter.migrations && p.frontmatter.migrations.length > 0),
    };

    await writePlanSet({ cwd, outputDir, planSetName, payload: planSetPayload });

    // Read back written plan files to build PlanFile array
    const planDir = resolve(cwd, outputDir, planSetName);
    const plans: PlanFile[] = [];
    for (const plan of planSetPayload.plans) {
      const filePath = resolve(planDir, `${plan.frontmatter.id}.md`);
      plans.push(await parsePlanFile(filePath));
    }

    const planConfigs = planSetPayload.orchestration.plans
      .filter(p => p.build || p.review)
      .map(p => ({
        id: p.id,
        ...(p.build !== undefined && { build: p.build }),
        ...(p.review !== undefined && { review: p.review }),
      }));

    yield {
      timestamp: new Date().toISOString(),
      type: 'planning:complete',
      plans,
      ...(planConfigs.length > 0 && { planConfigs }),
    };
    return;
  }

  // Handle architecture submission (expedition)
  if (captured.architecture) {
    const architecturePayload = captured.architecture;
    yield {
      timestamp: new Date().toISOString(),
      type: 'planning:submission',
      planCount: architecturePayload.modules.length,
      totalBodySize: architecturePayload.architecture.length,
      hasMigrations: false,
    };

    await writeArchitecture({ cwd, outputDir, planSetName, payload: architecturePayload });

    yield {
      timestamp: new Date().toISOString(),
      type: 'expedition:architecture:complete',
      modules: architecturePayload.modules.map(m => ({
        id: m.id,
        description: m.description,
        dependsOn: m.dependsOn,
      })),
    };
    return;
  }

  // Neither submission tool was called and no <skip> was emitted — this is a
  // retryable terminal error. Tailor the error to the tools that were actually
  // injected for this scope so the message matches what the agent had available.
  // Report the backend-visible names (each backend translates the bare name via
  // effectiveCustomToolName) so the message reflects what the agent was actually
  // told to call. The pipeline's continuation loop catches this and retries
  // within the shared planner-continuation budget.
  const injectedNames = customTools.map(t => harness.effectiveCustomToolName(t.name)).join(' / ');
  throw new PlannerSubmissionError(`Planner agent completed without calling a submission tool (${injectedNames}) or emitting <skip>`);
}

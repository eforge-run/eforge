import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AgentBackend, SdkPassthroughConfig } from '../backend.js';
import { pickSdkOptions } from '../backend.js';
import { isAlwaysYieldedAgentEvent, type EforgeEvent, type CompileOptions, type ClarificationQuestion, type PlanFile } from '../events.js';
import { parseClarificationBlocks, parseSkipBlock } from './common.js';
import { loadPrompt } from '../prompts.js';
import { parsePlanFile, deriveNameFromSource, extractPlanTitle } from '../plan.js';
import { getClarificationSchemaYaml, getModuleSchemaYaml, getPlanFrontmatterSchemaYaml } from '../schemas.js';

export interface PlannerOptions extends CompileOptions, SdkPassthroughConfig {
  backend: AgentBackend;
  onClarification?: (questions: ClarificationQuestion[]) => Promise<Record<string, string>>;
  /** Pre-determined scope from the pipeline composer (errand/excursion/expedition) */
  scope?: string;
  /** Override max conversation turns (default: 30) */
  maxTurns?: number;
  /** Continuation context when restarting after hitting max turns */
  continuationContext?: { attempt: number; maxContinuations: number; existingPlans: string };
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
  const { backend } = options;

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
  yield { timestamp: new Date().toISOString(), type: 'plan:start', source, ...(sourceLabel && { label: sourceLabel }) };
  yield { timestamp: new Date().toISOString(), type: 'plan:progress', message: 'Loading planner prompt...' };

  // Track clarification Q&A across iterations
  const allClarifications: Array<{ questions: ClarificationQuestion[]; answers: Record<string, string> }> = [];

  function buildPrompt(): Promise<string> {
    let continuationContextText = '';
    if (options.continuationContext) {
      const { attempt, maxContinuations, existingPlans } = options.continuationContext;
      continuationContextText = `## Continuation Context

This is continuation attempt ${attempt} of ${maxContinuations}. The planner hit the max turns limit on the previous attempt. The following plan files have already been written. Do NOT redo any of the completed work below.

### Existing Plans

${existingPlans}`;
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
      clarification_schema: getClarificationSchemaYaml(),
      module_schema: getModuleSchemaYaml(),
      plan_frontmatter_schema: getPlanFrontmatterSchemaYaml(),
    });
  }

  let skipEmitted = false;

  // Main loop: run agent, collect clarifications, restart with answers baked in
  let iteration = 0;
  const maxIterations = 5; // prevent infinite loops

  while (iteration < maxIterations) {
    iteration++;

    const prompt = await buildPrompt();

    if (iteration === 1) {
      yield { timestamp: new Date().toISOString(), type: 'plan:progress', message: 'Starting planner agent...' };
    } else {
      yield { timestamp: new Date().toISOString(), type: 'plan:progress', message: 'Planner restarted with prior clarifications' };
    }

    let needsRestart = false;

    for await (const event of backend.run(
      { prompt, cwd, maxTurns: options.maxTurns ?? 30, tools: 'coding', abortSignal: options.abortController?.signal, ...pickSdkOptions(options) },
      'planner',
    )) {
      if (event.type === 'agent:message') {
        if (!skipEmitted) {
          const skipReason = parseSkipBlock(event.content);
          if (skipReason) {
            skipEmitted = true;
            yield { timestamp: new Date().toISOString(), type: 'plan:skip', reason: skipReason };
          }
        }

        const questions = parseClarificationBlocks(event.content);
        if (questions.length > 0 && !options.auto) {
          yield { timestamp: new Date().toISOString(), type: 'plan:clarification', questions };

          if (options.onClarification) {
            const answers = await options.onClarification(questions);
            yield { timestamp: new Date().toISOString(), type: 'plan:clarification:answer', answers };
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

  // Skip was emitted — no plans to scan, no orchestration.yaml written
  if (skipEmitted) return;

  yield { timestamp: new Date().toISOString(), type: 'plan:progress', message: 'Scanning plan files...' };

  // Scan plan directory for generated plan files
  const planDir = resolve(cwd, options.outputDir ?? 'eforge/plans', planSetName);
  const plans: PlanFile[] = [];

  if (existsSync(planDir)) {
    const entries = await readdir(planDir);
    const mdFiles = entries.filter((f) => f.endsWith('.md')).sort();

    for (const file of mdFiles) {
      try {
        const plan = await parsePlanFile(resolve(planDir, file));
        plans.push(plan);
      } catch {
        // Skip non-plan .md files (e.g. README)
      }
    }
  }

  yield { timestamp: new Date().toISOString(), type: 'plan:complete', plans };
}

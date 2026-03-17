import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AgentBackend } from '../backend.js';
import { isAlwaysYieldedAgentEvent, SCOPE_ASSESSMENTS, type EforgeEvent, type CompileOptions, type ClarificationQuestion, type PlanFile, type ScopeAssessment } from '../events.js';
import { parseClarificationBlocks, parseScopeBlock, parseProfileBlock } from './common.js';
import { loadPrompt } from '../prompts.js';
import { parsePlanFile, deriveNameFromSource } from '../plan.js';
import type { ResolvedProfileConfig } from '../config.js';

export interface PlannerOptions extends CompileOptions {
  backend: AgentBackend;
  onClarification?: (questions: ClarificationQuestion[]) => Promise<Record<string, string>>;
  /** Available workflow profiles for profile selection. When provided, the planner selects a profile. */
  profiles?: Record<string, ResolvedProfileConfig>;
  /** Override max conversation turns (default: 30) */
  maxTurns?: number;
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
 * Format profile descriptions into a markdown table for prompt injection.
 * Returns empty string when no profiles are available.
 */
export function formatProfileDescriptions(profiles: Record<string, ResolvedProfileConfig>): string {
  if (Object.keys(profiles).length === 0) return '';

  const rows = Object.entries(profiles)
    .map(([name, profile]) => `| \`${name}\` | ${profile.description} |`)
    .join('\n');

  return `| Profile | Description |\n|---------|-------------|\n${rows}`;
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

  yield { type: 'plan:start', source };
  yield { type: 'plan:progress', message: 'Loading planner prompt...' };

  // Track clarification Q&A across iterations
  const allClarifications: Array<{ questions: ClarificationQuestion[]; answers: Record<string, string> }> = [];

  function buildPrompt(): Promise<string> {
    return loadPrompt('planner', {
      source: sourceContent,
      planSetName,
      cwd,
      priorClarifications: formatPriorClarifications(allClarifications),
      profiles: options.profiles ? formatProfileDescriptions(options.profiles) : '',
    });
  }

  let scopeEmitted = false;
  let profileEmitted = false;

  // Main loop: run agent, collect clarifications, restart with answers baked in
  let iteration = 0;
  const maxIterations = 5; // prevent infinite loops

  while (iteration < maxIterations) {
    iteration++;

    const prompt = await buildPrompt();

    if (iteration === 1) {
      yield { type: 'plan:progress', message: 'Starting planner agent...' };
    } else {
      yield { type: 'plan:progress', message: 'Planner restarted with prior clarifications' };
    }

    let needsRestart = false;

    for await (const event of backend.run(
      { prompt, cwd, maxTurns: options.maxTurns ?? 30, tools: 'coding', abortSignal: options.abortController?.signal },
      'planner',
    )) {
      if (event.type === 'agent:message') {
        if (!scopeEmitted) {
          const scope = parseScopeBlock(event.content);
          if (scope) {
            scopeEmitted = true;
            yield { type: 'plan:scope', assessment: scope.assessment, justification: scope.justification };
          }
        }

        if (!profileEmitted) {
          const profile = parseProfileBlock(event.content);
          if (profile) {
            profileEmitted = true;
            yield {
              type: 'plan:profile',
              profileName: profile.profileName,
              rationale: profile.rationale,
              config: options.profiles?.[profile.profileName],
            };

            // Derive plan:scope if profile name matches a built-in scope
            if (!scopeEmitted && (SCOPE_ASSESSMENTS as readonly string[]).includes(profile.profileName)) {
              scopeEmitted = true;
              yield {
                type: 'plan:scope',
                assessment: profile.profileName as ScopeAssessment,
                justification: profile.rationale,
              };
            }
          }
        }

        const questions = parseClarificationBlocks(event.content);
        if (questions.length > 0 && !options.auto) {
          yield { type: 'plan:clarification', questions };

          if (options.onClarification) {
            const answers = await options.onClarification(questions);
            yield { type: 'plan:clarification:answer', answers };
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

  yield { type: 'plan:progress', message: 'Scanning plan files...' };

  // Scan plan directory for generated plan files
  const planDir = resolve(cwd, 'plans', planSetName);
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

  yield { type: 'plan:complete', plans };
}

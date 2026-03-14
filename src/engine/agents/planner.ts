import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ForgeEvent, PlanOptions, ClarificationQuestion, PlanFile } from '../events.js';
import { mapSDKMessages, parseClarificationBlocks, parseScopeBlock } from './common.js';
import { loadPrompt } from '../prompts.js';
import { parsePlanFile, deriveNameFromSource } from '../plan.js';

export interface PlannerOptions extends PlanOptions {
  onClarification?: (questions: ClarificationQuestion[]) => Promise<Record<string, string>>;
  abortController?: AbortController;
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
 * Run the planner agent. One-shot SDK query that explores the codebase,
 * asks clarifying questions via <clarification> XML blocks, and writes
 * plan files to disk.
 *
 * If the SDK subprocess dies while waiting for clarification answers (e.g.
 * user stepped away), the planner automatically retries with answers baked
 * into the prompt.
 *
 * @param source - PRD file path or inline prompt string
 * @param options - Planner configuration
 * @yields ForgeEvent stream
 */
export async function* runPlanner(
  source: string,
  options: PlannerOptions = {},
): AsyncGenerator<ForgeEvent> {
  const cwd = options.cwd ?? process.cwd();

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

  // Track clarification Q&A across the session for potential retry
  const allClarifications: Array<{ questions: ClarificationQuestion[]; answers: Record<string, string> }> = [];

  function buildPrompt(): Promise<string> {
    return loadPrompt('planner', {
      source: sourceContent,
      planSetName,
      cwd,
      priorClarifications: formatPriorClarifications(allClarifications),
    });
  }

  function createQuery(prompt: string) {
    return sdkQuery({
      prompt,
      options: {
        cwd,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        maxTurns: 30,
        tools: { type: 'preset', preset: 'claude_code' },
        abortController: options.abortController,
      },
    });
  }

  let prompt = await buildPrompt();
  let q = createQuery(prompt);

  yield { type: 'plan:progress', message: 'Starting planner agent...' };

  // Shared event-processing logic for both initial run and retry
  let scopeEmitted = false;

  async function* processEvents(
    query: ReturnType<typeof createQuery>,
    /** When true, streamInput failures trigger a retry instead of propagating */
    allowRetry: boolean,
  ): AsyncGenerator<ForgeEvent | { type: '__retry__' }> {
    for await (const event of mapSDKMessages(query, 'planner')) {
      if (event.type === 'agent:message') {
        if (!scopeEmitted) {
          const scope = parseScopeBlock(event.content);
          if (scope) {
            scopeEmitted = true;
            yield { type: 'plan:scope', assessment: scope.assessment, justification: scope.justification };
          }
        }

        const questions = parseClarificationBlocks(event.content);
        if (questions.length > 0 && !options.auto) {
          yield { type: 'plan:clarification', questions };

          if (options.onClarification) {
            const answers = await options.onClarification(questions);
            yield { type: 'plan:clarification:answer', answers };

            allClarifications.push({ questions, answers });

            const answerText = Object.entries(answers)
              .map(([id, answer]) => `${id}: ${answer}`)
              .join('\n');

            try {
              await query.streamInput(
                (async function* (): AsyncGenerator<SDKUserMessage> {
                  yield {
                    type: 'user',
                    message: { role: 'user', content: answerText },
                    parent_tool_use_id: null,
                    session_id: '',
                  } as SDKUserMessage;
                })(),
              );
            } catch {
              if (allowRetry) {
                yield { type: '__retry__' };
                return;
              }
              throw new Error('Planner transport died while feeding clarification answers');
            }
          }
        }
      }

      // Always yield agent:result + tool events (for tracing); gate streaming text on verbose
      if (event.type === 'agent:result' || event.type === 'agent:tool_use' || event.type === 'agent:tool_result' || options.verbose) {
        yield event;
      }
    }
  }

  // Run the query event loop, with one retry if the transport dies after clarification
  let needsRetry = false;

  try {
    for await (const event of processEvents(q, true)) {
      if (event.type === '__retry__') {
        needsRetry = true;
        break;
      }
      yield event as ForgeEvent;
    }
  } catch (err) {
    // Transport death can also surface on the iterator's next() call
    if (allClarifications.length > 0) {
      needsRetry = true;
    } else {
      throw err instanceof Error ? err : new Error('Planner agent failed unexpectedly');
    }
  }

  // Retry: start a fresh query with clarification answers baked into the prompt
  if (needsRetry) {
    yield { type: 'plan:progress', message: 'Session expired, restarting planner with your answers...' };

    prompt = await buildPrompt();
    q = createQuery(prompt);

    yield { type: 'plan:progress', message: 'Planner restarted with prior clarifications' };

    for await (const event of processEvents(q, false)) {
      yield event as ForgeEvent;
    }
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


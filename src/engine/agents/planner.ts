import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ForgeEvent, PlanOptions, ClarificationQuestion, PlanFile } from '../events.js';
import { mapSDKMessages, parseClarificationBlocks } from './common.js';
import { loadPrompt } from '../prompts.js';
import { parsePlanFile } from '../plan.js';

export interface PlannerOptions extends PlanOptions {
  onClarification?: (questions: ClarificationQuestion[]) => Promise<Record<string, string>>;
  abortController?: AbortController;
}

/**
 * Run the planner agent. One-shot SDK query that explores the codebase,
 * asks clarifying questions via <clarification> XML blocks, and writes
 * plan files to disk.
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

  const prompt = await loadPrompt('planner', {
    source: sourceContent,
    planSetName,
    cwd,
  });

  yield { type: 'plan:progress', message: 'Starting planner agent...' };

  const q = sdkQuery({
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

  for await (const event of mapSDKMessages(q, 'planner')) {
    // Detect clarification blocks in agent text output
    if (event.type === 'agent:message') {
      const questions = parseClarificationBlocks(event.content);

      if (questions.length > 0 && !options.auto) {
        yield { type: 'plan:clarification', questions };

        if (options.onClarification) {
          const answers = await options.onClarification(questions);
          yield { type: 'plan:clarification:answer', answers };

          // Feed answers back into the running query
          const answerText = Object.entries(answers)
            .map(([id, answer]) => `${id}: ${answer}`)
            .join('\n');

          await q.streamInput(
            (async function* (): AsyncGenerator<SDKUserMessage> {
              yield {
                type: 'user',
                message: { role: 'user', content: answerText },
                parent_tool_use_id: null,
                session_id: '',
              } as SDKUserMessage;
            })(),
          );
        }
      }
    }

    // Forward agent-level events when verbose
    if (options.verbose) {
      yield event;
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

/**
 * Derive a kebab-case plan set name from a source string.
 * If it looks like a file path, use the filename without extension.
 */
function deriveNameFromSource(source: string): string {
  const basename = source.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
  return basename
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .toLowerCase();
}

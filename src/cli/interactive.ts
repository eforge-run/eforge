import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import type { ClarificationQuestion } from '../engine/events.js';

/**
 * Create a clarification callback for the engine.
 * Auto mode returns defaults without prompting; interactive mode uses readline.
 */
export function createClarificationHandler(
  auto: boolean,
): (questions: ClarificationQuestion[]) => Promise<Record<string, string>> {
  if (auto) {
    return async (questions) => {
      const answers: Record<string, string> = {};
      for (const q of questions) {
        answers[q.id] = q.default ?? '';
      }
      return answers;
    };
  }

  return async (questions) => {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    const answers: Record<string, string> = {};
    try {
      for (const q of questions) {
        const prompt = q.default ? `${q.question} [${q.default}]: ` : `${q.question}: `;
        const answer = await rl.question(prompt);
        answers[q.id] = answer || (q.default ?? '');
      }
    } finally {
      rl.close();
    }
    return answers;
  };
}

/**
 * Create an approval callback for the engine.
 * Auto mode always approves; interactive mode prompts y/N via readline.
 */
export function createApprovalHandler(
  auto: boolean,
): (action: string, details: string) => Promise<boolean> {
  if (auto) {
    return async () => true;
  }

  return async (_action, _details) => {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    try {
      const answer = await rl.question('Approve? [y/N]: ');
      return answer.toLowerCase() === 'y';
    } finally {
      rl.close();
    }
  };
}

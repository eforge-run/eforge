import type { AgentBackend } from '../backend.js';
import { isAlwaysYieldedAgentEvent, type EforgeEvent } from '../events.js';
import type { MergeConflictInfo } from '../worktree.js';
import { loadPrompt } from '../prompts.js';

export interface MergeConflictResolverOptions {
  backend: AgentBackend;
  cwd: string;
  conflict: MergeConflictInfo;
  verbose?: boolean;
  abortController?: AbortController;
}

/**
 * Merge conflict resolver agent — one-shot coding agent that resolves
 * git merge conflicts by understanding intent from both plans' summaries,
 * reading conflicted files, and editing them to resolve all conflict markers.
 */
export async function* runMergeConflictResolver(
  options: MergeConflictResolverOptions,
): AsyncGenerator<EforgeEvent> {
  yield { type: 'merge:resolve:start', planId: options.conflict.branch };

  const prompt = await loadPrompt('merge-conflict-resolver', {
    branch: options.conflict.branch,
    base_branch: options.conflict.baseBranch,
    conflicted_files: options.conflict.conflictedFiles.join('\n'),
    conflict_diff: options.conflict.conflictDiff,
    plan_name: options.conflict.planName ?? '',
    plan_summary: options.conflict.planSummary ?? '',
    other_plan_name: options.conflict.otherPlanName ?? '',
    other_plan_summary: options.conflict.otherPlanSummary ?? '',
  });

  try {
    for await (const event of options.backend.run(
      {
        prompt,
        cwd: options.cwd,
        maxTurns: 30,
        tools: 'coding',
        abortSignal: options.abortController?.signal,
      },
      'merge-conflict-resolver',
    )) {
      if (isAlwaysYieldedAgentEvent(event) || options.verbose) {
        yield event;
      }
    }
  } catch (err) {
    // Re-throw abort errors so the orchestrator can respect cancellation
    if (err instanceof Error && err.name === 'AbortError') throw err;
    // Other resolver failures are non-fatal — fall through to resolved: false
    yield { type: 'merge:resolve:complete', planId: options.conflict.branch, resolved: false };
    return;
  }

  yield { type: 'merge:resolve:complete', planId: options.conflict.branch, resolved: true };
}

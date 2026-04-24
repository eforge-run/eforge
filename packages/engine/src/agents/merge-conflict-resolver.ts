import type { AgentBackend, SdkPassthroughConfig } from '../backend.js';
import { pickSdkOptions } from '../backend.js';
import { isAlwaysYieldedAgentEvent, type EforgeEvent } from '../events.js';
import type { MergeConflictInfo } from '../worktree-ops.js';
import { loadPrompt } from '../prompts.js';

export interface MergeConflictResolverOptions extends SdkPassthroughConfig {
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
  yield { timestamp: new Date().toISOString(), type: 'plan:merge:resolve:start', planId: options.conflict.branch };

  const prompt = await loadPrompt('merge-conflict-resolver', {
    branch: options.conflict.branch,
    base_branch: options.conflict.baseBranch,
    conflicted_files: options.conflict.conflictedFiles.join('\n'),
    conflict_diff: options.conflict.conflictDiff,
    plan_name: options.conflict.planName ?? '',
    plan_summary: options.conflict.planSummary ?? '',
    other_plan_name: options.conflict.otherPlanName ?? '',
    other_plan_summary: options.conflict.otherPlanSummary ?? '',
  }, options.promptAppend);

  try {
    for await (const event of options.backend.run(
      {
        prompt,
        cwd: options.cwd,
        maxTurns: 30,
        tools: 'coding',
        abortSignal: options.abortController?.signal,
        ...pickSdkOptions(options),
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
    yield { timestamp: new Date().toISOString(), type: 'plan:merge:resolve:complete', planId: options.conflict.branch, resolved: false };
    return;
  }

  yield { timestamp: new Date().toISOString(), type: 'plan:merge:resolve:complete', planId: options.conflict.branch, resolved: true };
}

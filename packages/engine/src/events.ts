// EforgeEvent discriminated union and all supporting types

import type { z } from 'zod/v4';
import type { BuildStageSpec, ReviewProfileConfig } from './config.js';
import type { ReviewPerspective } from './review-heuristics.js';
import type { reviewIssueSchema, expeditionModuleSchema, clarificationQuestionSchema, PipelineComposition } from './schemas.js';
import type { AgentTerminalSubtype } from './backend.js';

export const ORCHESTRATION_MODES = ['errand', 'excursion', 'expedition'] as const;

export type AgentRole = 'planner' | 'builder' | 'reviewer' | 'review-fixer' | 'evaluator' | 'module-planner' | 'plan-reviewer' | 'plan-evaluator' | 'architecture-reviewer' | 'architecture-evaluator' | 'cohesion-reviewer' | 'cohesion-evaluator' | 'validation-fixer' | 'merge-conflict-resolver' | 'staleness-assessor' | 'formatter' | 'doc-updater' | 'test-writer' | 'tester' | 'prd-validator' | 'dependency-detector' | 'pipeline-composer' | 'gap-closer';

export interface PrdValidationGap {
  requirement: string;
  explanation: string;
  complexity?: 'trivial' | 'moderate' | 'significant';
}

export type ExpeditionModule = z.output<typeof expeditionModuleSchema>;

export type EforgeResult = { status: 'completed' | 'failed' | 'skipped'; summary: string };

export type ClarificationQuestion = z.output<typeof clarificationQuestionSchema>;

export type ReviewIssue = z.output<typeof reviewIssueSchema>;

export interface TestIssue {
  severity: 'critical' | 'warning';
  category: 'production-bug' | 'missing-behavior' | 'regression';
  file: string;
  testFile: string;
  description: string;
  testOutput?: string;
  fix?: string;
}

export const SEVERITY_ORDER: Record<ReviewIssue['severity'], number> = {
  critical: 0,
  warning: 1,
  suggestion: 2,
};

export interface PlanFile {
  id: string;
  name: string;
  dependsOn: string[];
  branch: string;
  migrations?: Array<{ timestamp: string; description: string }>;
  agents?: Record<string, { effort?: string; thinking?: object; rationale?: string }>;
  body: string;
  filePath: string;
  /** Parsing warnings collected when the plan file was read (e.g. malformed agents block). */
  warnings?: string[];
}

export interface OrchestrationConfig {
  name: string;
  description: string;
  created: string;
  mode: (typeof ORCHESTRATION_MODES)[number];
  baseBranch: string;
  pipeline: PipelineComposition;
  plans: Array<{ id: string; name: string; dependsOn: string[]; branch: string; build: BuildStageSpec[]; review: ReviewProfileConfig; maxContinuations?: number; agents?: Record<string, { effort?: string; thinking?: object; rationale?: string }> }>;
  validate?: string[];
  /** Parsing warnings collected when the orchestration config was read. */
  warnings?: string[];
}

export interface PlanState {
  status: 'pending' | 'running' | 'completed' | 'failed' | 'blocked' | 'merged';
  worktreePath?: string;
  branch: string;
  dependsOn: string[];
  merged: boolean;
  error?: string;
}

export interface EforgeState {
  setName: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  completedAt?: string;
  baseBranch: string;
  featureBranch?: string;
  worktreeBase: string;
  mergeWorktreePath?: string;
  plans: Record<string, PlanState>;
  completedPlans: string[];
}

export interface AgentResultData {
  durationMs: number;
  durationApiMs: number;
  numTurns: number;
  totalCostUsd: number;
  usage: { input: number; output: number; total: number; cacheRead: number; cacheCreation: number };
  /** Per-model token and cost breakdown, keyed by model name */
  modelUsage: Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number; costUSD: number }>;
  /** Final result text from the agent (used as generation output in traces) */
  resultText?: string;
}

export interface CompileOptions {
  auto?: boolean;
  verbose?: boolean;
  name?: string;
  cwd?: string;
  abortController?: AbortController;
}

export interface BuildOptions {
  auto?: boolean;
  verbose?: boolean;
  dryRun?: boolean;
  cleanup?: boolean;
  cwd?: string;
  abortController?: AbortController;
  prdFilePath?: string;
}

export interface EnqueueOptions {
  name?: string;
  verbose?: boolean;
  auto?: boolean;
  abortController?: AbortController;
}

export interface ReconciliationReport {
  /** Plan IDs with valid, existing worktrees on correct branches. */
  valid: string[];
  /** Plan IDs whose worktrees are missing from the filesystem. */
  missing: string[];
  /** Plan IDs whose worktrees exist but are on the wrong branch or detached. */
  corrupt: string[];
  /** Plan IDs whose worktreePath was cleared in state (union of missing + corrupt). */
  cleared: string[];
}

export interface EforgeStatus {
  running: boolean;
  setName?: string;
  plans: Record<string, PlanState['status']>;
  completedPlans: string[];
}

export type EforgeEvent = { sessionId?: string; runId?: string; timestamp: string } & (
  // Session lifecycle (one per eforge invocation, wraps all phases)
  | { type: 'session:start'; sessionId: string }
  | { type: 'session:end'; sessionId: string; result: EforgeResult }

  // Phase lifecycle (one per compile/build phase)
  | { type: 'phase:start'; runId: string; planSet: string; command: 'compile' | 'build' }
  | { type: 'phase:end'; runId: string; result: EforgeResult }

  // Config and plan warnings (emitted when config or plan files contain invalid/unexpected fields)
  | { type: 'config:warning'; message: string; source: string; details?: string }
  | { type: 'planning:warning'; planId?: string; message: string; source: string; details?: string }

  // Planning (compile-phase activity — fires once per planning phase, not per plan)
  | { type: 'planning:start'; source: string; label?: string }
  | { type: 'planning:skip'; reason: string }
  | { type: 'planning:submission'; planCount: number; totalBodySize: number; hasMigrations: boolean }
  | { type: 'planning:error'; reason: string }
  | { type: 'planning:clarification'; questions: ClarificationQuestion[] }
  | { type: 'planning:clarification:answer'; answers: Record<string, string> }
  | { type: 'planning:progress'; message: string }
  | { type: 'planning:continuation'; attempt: number; maxContinuations: number; reason?: 'max_turns' | 'dropped_submission' }
  | { type: 'planning:pipeline'; scope: string; compile: string[]; defaultBuild: BuildStageSpec[]; defaultReview: ReviewProfileConfig; rationale: string }
  | { type: 'planning:complete'; plans: PlanFile[] }

  // Planning review (after planning phase — fires once per planning phase)
  | { type: 'planning:review:start' }
  | { type: 'planning:review:complete'; issues: ReviewIssue[] }
  | { type: 'planning:evaluate:start' }
  | { type: 'planning:evaluate:continuation'; attempt: number; maxContinuations: number }
  | { type: 'planning:evaluate:complete'; accepted: number; rejected: number; verdicts?: Array<{ file: string; action: 'accept' | 'reject' | 'review'; reason: string }> }

  // Architecture review (expedition architecture validation — fires once per planning phase)
  | { type: 'planning:architecture:review:start' }
  | { type: 'planning:architecture:review:complete'; issues: ReviewIssue[] }
  | { type: 'planning:architecture:evaluate:start' }
  | { type: 'planning:architecture:evaluate:continuation'; attempt: number; maxContinuations: number }
  | { type: 'planning:architecture:evaluate:complete'; accepted: number; rejected: number; verdicts?: Array<{ file: string; action: 'accept' | 'reject' | 'review'; reason: string }> }

  // Cohesion review (expedition cross-module validation — fires once per planning phase)
  | { type: 'planning:cohesion:start' }
  | { type: 'planning:cohesion:complete'; issues: ReviewIssue[] }
  | { type: 'planning:cohesion:evaluate:start' }
  | { type: 'planning:cohesion:evaluate:continuation'; attempt: number; maxContinuations: number }
  | { type: 'planning:cohesion:evaluate:complete'; accepted: number; rejected: number; verdicts?: Array<{ file: string; action: 'accept' | 'reject' | 'review'; reason: string }> }

  // Building (per-plan — all carry planId)
  | { type: 'plan:build:start'; planId: string }
  | { type: 'plan:build:implement:start'; planId: string }
  | { type: 'plan:build:implement:progress'; planId: string; message: string }
  | { type: 'plan:build:implement:continuation'; planId: string; attempt: number; maxContinuations: number }
  | { type: 'plan:build:implement:complete'; planId: string }
  | { type: 'plan:build:files_changed'; planId: string; files: string[]; diffs?: Array<{ path: string; diff: string }>; baseBranch?: string }
  | { type: 'plan:build:review:start'; planId: string }
  | { type: 'plan:build:review:complete'; planId: string; issues: ReviewIssue[] }
  | { type: 'plan:build:review:parallel:start'; planId: string; perspectives: ReviewPerspective[] }
  | { type: 'plan:build:review:parallel:perspective:start'; planId: string; perspective: ReviewPerspective }
  | { type: 'plan:build:review:parallel:perspective:complete'; planId: string; perspective: ReviewPerspective; issues: ReviewIssue[] }
  | { type: 'plan:build:review:fix:start'; planId: string; issueCount: number }
  | { type: 'plan:build:review:fix:complete'; planId: string }
  | { type: 'plan:build:evaluate:start'; planId: string }
  | { type: 'plan:build:evaluate:continuation'; planId: string; attempt: number; maxContinuations: number }
  | { type: 'plan:build:evaluate:complete'; planId: string; accepted: number; rejected: number; verdicts?: Array<{ file: string; action: 'accept' | 'reject' | 'review'; reason: string }> }
  | { type: 'plan:build:doc-update:start'; planId: string }
  | { type: 'plan:build:doc-update:complete'; planId: string; docsUpdated: number }
  | { type: 'plan:build:test:write:start'; planId: string }
  | { type: 'plan:build:test:write:complete'; planId: string; testsWritten: number }
  | { type: 'plan:build:test:start'; planId: string }
  | { type: 'plan:build:test:complete'; planId: string; passed: number; failed: number; testBugsFixed: number; productionIssues: TestIssue[] }
  | { type: 'plan:build:complete'; planId: string }
  | { type: 'plan:build:failed'; planId: string; error: string; terminalSubtype?: AgentTerminalSubtype }
  | { type: 'plan:build:progress'; planId: string; message: string }

  // Orchestration
  | { type: 'schedule:start'; planIds: string[] }
  | { type: 'plan:schedule:ready'; planId: string; reason: string }
  | { type: 'plan:merge:start'; planId: string }
  | { type: 'plan:merge:complete'; planId: string; commitSha?: string }
  | { type: 'plan:merge:resolve:start'; planId: string }
  | { type: 'plan:merge:resolve:complete'; planId: string; resolved: boolean }
  | { type: 'merge:finalize:start'; featureBranch: string; baseBranch: string }
  | { type: 'merge:finalize:complete'; featureBranch: string; baseBranch: string; commitSha?: string }
  | { type: 'merge:finalize:skipped'; featureBranch: string; baseBranch: string; reason: string }

  // Expedition planning phases
  | { type: 'expedition:architecture:complete'; modules: ExpeditionModule[] }
  | { type: 'expedition:wave:start'; wave: number; moduleIds: string[] }
  | { type: 'expedition:wave:complete'; wave: number }
  | { type: 'expedition:module:start'; moduleId: string }
  | { type: 'expedition:module:complete'; moduleId: string }
  | { type: 'expedition:compile:start' }
  | { type: 'expedition:compile:complete'; plans: PlanFile[] }

  // Agent lifecycle (emitted by backend for every agent invocation)
  | { type: 'agent:start'; planId?: string; agentId: string; agent: AgentRole; model: string; backend: string; fallbackFrom?: string; effort?: string; thinking?: object; effortClamped?: boolean; effortOriginal?: string; effortSource?: 'planner' | 'role-config' | 'global-config' | 'default'; thinkingSource?: 'planner' | 'role-config' | 'global-config' | 'default'; thinkingCoerced?: boolean; thinkingOriginal?: object }
  | { type: 'agent:warning'; planId?: string; agentId: string; agent: AgentRole; code: string; message: string }
  | { type: 'agent:stop'; planId?: string; agentId: string; agent: AgentRole; error?: string }
  /**
   * Token/cost usage report for an agent run.
   *
   * Emission cadence (shared by every backend):
   *  - After each assistant turn that reports usage, as a **per-turn delta**.
   *  - Once at session end, as the **final cumulative total**, identifiable
   *    by `final: true`.
   *
   * Consumers that need authoritative totals should prefer the final event.
   * Consumers that need live progress should aggregate the non-final deltas.
   * Mixing the two without branching on `final` will double-count usage.
   */
  | { type: 'agent:usage'; planId?: string; agentId: string; agent: AgentRole; usage: { input: number; output: number; total: number; cacheRead: number; cacheCreation: number }; costUsd: number; numTurns: number; final?: boolean }

  // Agent-level (verbose streaming)
  | { type: 'agent:message'; planId?: string; agentId: string; agent: AgentRole; content: string }
  | { type: 'agent:tool_use'; planId?: string; agentId: string; agent: AgentRole; tool: string; toolUseId: string; input: unknown }
  | { type: 'agent:tool_result'; planId?: string; agentId: string; agent: AgentRole; tool: string; toolUseId: string; output: string }
  | { type: 'agent:result'; planId?: string; agent: AgentRole; result: AgentResultData }

  // Generic retry notification emitted by the shared retry wrapper (in addition to
  // any agent-specific continuation event such as planning:continuation,
  // plan:build:implement:continuation, or plan:build:evaluate:continuation).
  | { type: 'agent:retry'; agent: AgentRole; attempt: number; maxAttempts: number; subtype: AgentTerminalSubtype; label: string; planId?: string }

  // Validation (post-merge)
  | { type: 'validation:start'; commands: string[] }
  | { type: 'validation:command:start'; command: string }
  | { type: 'validation:command:complete'; command: string; exitCode: number; output: string }
  | { type: 'validation:command:timeout'; command: string; timeoutMs: number; pid: number }
  | { type: 'validation:complete'; passed: boolean }
  | { type: 'validation:fix:start'; attempt: number; maxAttempts: number }
  | { type: 'validation:fix:complete'; attempt: number }

  // PRD validation (post-merge, after validation)
  | { type: 'prd_validation:start' }
  | { type: 'prd_validation:complete'; passed: boolean; gaps: PrdValidationGap[]; completionPercent?: number }

  // Gap closing (PRD validation gap remediation)
  | { type: 'gap_close:start'; gapCount?: number; completionPercent?: number }
  | { type: 'gap_close:plan_ready'; planBody: string; gaps: PrdValidationGap[] }
  | { type: 'gap_close:complete'; passed?: boolean }

  // Reconciliation (resume)
  | { type: 'reconciliation:start' }
  | { type: 'reconciliation:complete'; report: ReconciliationReport }

  // Cleanup (post-build)
  | { type: 'cleanup:start'; planSet: string }
  | { type: 'cleanup:complete'; planSet: string }

  // User interaction
  | { type: 'approval:needed'; planId?: string; action: string; details: string }
  | { type: 'approval:response'; approved: boolean }

  // Enqueue
  | { type: 'enqueue:start'; source: string }
  | { type: 'enqueue:complete'; id: string; filePath: string; title: string }
  | { type: 'enqueue:failed'; error: string }
  | { type: 'enqueue:commit-failed'; error: string }

  // Queue
  | QueueEvent
);

export type StalenessVerdict = 'proceed' | 'revise' | 'obsolete';

export type QueueEvent =
  | { type: 'queue:start'; prdCount: number; dir: string }
  | { type: 'queue:prd:start'; prdId: string; title: string }
  | { type: 'queue:prd:discovered'; prdId: string; title: string }
  | { type: 'queue:prd:stale'; verdict: StalenessVerdict; justification: string; revision?: string }
  | { type: 'queue:prd:skip'; prdId: string; reason: string }
  | { type: 'queue:prd:commit-failed'; prdId: string; error: string }
  | { type: 'queue:prd:complete'; prdId: string; status: 'completed' | 'failed' | 'skipped' }
  | { type: 'queue:complete'; processed: number; skipped: number };

/** Agent event types that runners always yield (not gated on verbose). */
export function isAlwaysYieldedAgentEvent(event: EforgeEvent): boolean {
  return event.type === 'agent:start'
    || event.type === 'agent:warning'
    || event.type === 'agent:stop'
    || event.type === 'agent:result'
    || event.type === 'agent:usage'
    || event.type === 'agent:tool_use'
    || event.type === 'agent:tool_result';
}

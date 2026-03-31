// EforgeEvent discriminated union and all supporting types

import type { z } from 'zod/v4';
import type { ResolvedProfileConfig, BuildStageSpec, ReviewProfileConfig } from './config.js';
import type { ReviewPerspective } from './review-heuristics.js';
import type { reviewIssueSchema, expeditionModuleSchema, clarificationQuestionSchema } from './schemas.js';

export const ORCHESTRATION_MODES = ['errand', 'excursion', 'expedition'] as const;

export type AgentRole = 'planner' | 'builder' | 'reviewer' | 'review-fixer' | 'evaluator' | 'module-planner' | 'plan-reviewer' | 'plan-evaluator' | 'architecture-reviewer' | 'architecture-evaluator' | 'cohesion-reviewer' | 'cohesion-evaluator' | 'validation-fixer' | 'merge-conflict-resolver' | 'staleness-assessor' | 'formatter' | 'doc-updater' | 'test-writer' | 'tester' | 'prd-validator' | 'dependency-detector';

export interface PrdValidationGap {
  requirement: string;
  explanation: string;
}

export type ExpeditionModule = z.output<typeof expeditionModuleSchema>;

export type EforgeResult = { status: 'completed' | 'failed'; summary: string };

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
  body: string;
  filePath: string;
}

export interface OrchestrationConfig {
  name: string;
  description: string;
  created: string;
  mode: (typeof ORCHESTRATION_MODES)[number];
  baseBranch: string;
  profile: ResolvedProfileConfig;
  plans: Array<{ id: string; name: string; dependsOn: string[]; branch: string; build: BuildStageSpec[]; review: ReviewProfileConfig; maxContinuations?: number }>;
  validate?: string[];
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
  generateProfile?: boolean;
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

  // Planning
  | { type: 'plan:start'; source: string; label?: string }
  | { type: 'plan:skip'; reason: string }
  | { type: 'plan:profile'; profileName: string; rationale: string; config?: import('./config.js').ResolvedProfileConfig }
  | { type: 'plan:clarification'; questions: ClarificationQuestion[] }
  | { type: 'plan:clarification:answer'; answers: Record<string, string> }
  | { type: 'plan:progress'; message: string }
  | { type: 'plan:continuation'; attempt: number; maxContinuations: number }
  | { type: 'plan:complete'; plans: PlanFile[] }

  // Plan review (after planning phase)
  | { type: 'plan:review:start' }
  | { type: 'plan:review:complete'; issues: ReviewIssue[] }
  | { type: 'plan:evaluate:start' }
  | { type: 'plan:evaluate:complete'; accepted: number; rejected: number; verdicts?: Array<{ file: string; action: 'accept' | 'reject' | 'review'; reason: string }> }

  // Architecture review (expedition architecture validation)
  | { type: 'plan:architecture:review:start' }
  | { type: 'plan:architecture:review:complete'; issues: ReviewIssue[] }
  | { type: 'plan:architecture:evaluate:start' }
  | { type: 'plan:architecture:evaluate:complete'; accepted: number; rejected: number; verdicts?: Array<{ file: string; action: 'accept' | 'reject' | 'review'; reason: string }> }

  // Cohesion review (expedition cross-module validation)
  | { type: 'plan:cohesion:start' }
  | { type: 'plan:cohesion:complete'; issues: ReviewIssue[] }
  | { type: 'plan:cohesion:evaluate:start' }
  | { type: 'plan:cohesion:evaluate:complete'; accepted: number; rejected: number; verdicts?: Array<{ file: string; action: 'accept' | 'reject' | 'review'; reason: string }> }

  // Building (per-plan)
  | { type: 'build:start'; planId: string }
  | { type: 'build:implement:start'; planId: string }
  | { type: 'build:implement:progress'; planId: string; message: string }
  | { type: 'build:implement:continuation'; planId: string; attempt: number; maxContinuations: number }
  | { type: 'build:implement:complete'; planId: string }
  | { type: 'build:files_changed'; planId: string; files: string[]; diffs?: Array<{ path: string; diff: string }>; baseBranch?: string }
  | { type: 'build:review:start'; planId: string }
  | { type: 'build:review:complete'; planId: string; issues: ReviewIssue[] }
  | { type: 'build:review:parallel:start'; planId: string; perspectives: ReviewPerspective[] }
  | { type: 'build:review:parallel:perspective:start'; planId: string; perspective: ReviewPerspective }
  | { type: 'build:review:parallel:perspective:complete'; planId: string; perspective: ReviewPerspective; issues: ReviewIssue[] }
  | { type: 'build:review:fix:start'; planId: string; issueCount: number }
  | { type: 'build:review:fix:complete'; planId: string }
  | { type: 'build:evaluate:start'; planId: string }
  | { type: 'build:evaluate:complete'; planId: string; accepted: number; rejected: number; verdicts?: Array<{ file: string; action: 'accept' | 'reject' | 'review'; reason: string }> }
  | { type: 'build:doc-update:start'; planId: string }
  | { type: 'build:doc-update:complete'; planId: string; docsUpdated: number }
  | { type: 'build:test:write:start'; planId: string }
  | { type: 'build:test:write:complete'; planId: string; testsWritten: number }
  | { type: 'build:test:start'; planId: string }
  | { type: 'build:test:complete'; planId: string; passed: number; failed: number; testBugsFixed: number; productionIssues: TestIssue[] }
  | { type: 'build:complete'; planId: string }
  | { type: 'build:failed'; planId: string; error: string }

  // Orchestration
  | { type: 'schedule:start'; planIds: string[] }
  | { type: 'schedule:ready'; planId: string; reason: string }
  | { type: 'merge:start'; planId: string }
  | { type: 'merge:complete'; planId: string; commitSha?: string }
  | { type: 'merge:resolve:start'; planId: string }
  | { type: 'merge:resolve:complete'; planId: string; resolved: boolean }
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
  | { type: 'agent:start'; planId?: string; agentId: string; agent: AgentRole; model: string; backend: string }
  | { type: 'agent:stop'; planId?: string; agentId: string; agent: AgentRole; error?: string }

  // Agent-level (verbose streaming)
  | { type: 'agent:message'; planId?: string; agentId: string; agent: AgentRole; content: string }
  | { type: 'agent:tool_use'; planId?: string; agentId: string; agent: AgentRole; tool: string; toolUseId: string; input: unknown }
  | { type: 'agent:tool_result'; planId?: string; agentId: string; agent: AgentRole; tool: string; toolUseId: string; output: string }
  | { type: 'agent:result'; planId?: string; agent: AgentRole; result: AgentResultData }

  // Validation (post-merge)
  | { type: 'validation:start'; commands: string[] }
  | { type: 'validation:command:start'; command: string }
  | { type: 'validation:command:complete'; command: string; exitCode: number; output: string }
  | { type: 'validation:complete'; passed: boolean }
  | { type: 'validation:fix:start'; attempt: number; maxAttempts: number }
  | { type: 'validation:fix:complete'; attempt: number }

  // PRD validation (post-merge, after validation)
  | { type: 'prd_validation:start' }
  | { type: 'prd_validation:complete'; passed: boolean; gaps: PrdValidationGap[] }

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
  | { type: 'queue:prd:stale'; verdict: StalenessVerdict; justification: string; revision?: string }
  | { type: 'queue:prd:skip'; prdId: string; reason: string }
  | { type: 'queue:prd:commit-failed'; prdId: string; error: string }
  | { type: 'queue:prd:complete'; prdId: string; status: 'completed' | 'failed' | 'skipped' }
  | { type: 'queue:complete'; processed: number; skipped: number }
  | { type: 'queue:watch:waiting'; pollIntervalMs: number }
  | { type: 'queue:watch:poll' }
  | { type: 'queue:watch:cycle'; processed: number; skipped: number };

/** Agent event types that runners always yield (not gated on verbose). */
export function isAlwaysYieldedAgentEvent(event: EforgeEvent): boolean {
  return event.type === 'agent:start'
    || event.type === 'agent:stop'
    || event.type === 'agent:result'
    || event.type === 'agent:tool_use'
    || event.type === 'agent:tool_result';
}

// EforgeEvent discriminated union and all supporting types

export const ORCHESTRATION_MODES = ['errand', 'excursion', 'expedition'] as const;
export const SCOPE_ASSESSMENTS = ['complete', ...ORCHESTRATION_MODES] as const;
export type ScopeAssessment = (typeof SCOPE_ASSESSMENTS)[number];

export type AgentRole = 'planner' | 'builder' | 'reviewer' | 'evaluator' | 'module-planner' | 'plan-reviewer' | 'plan-evaluator' | 'cohesion-reviewer' | 'cohesion-evaluator' | 'validation-fixer' | 'assessor';

export interface ExpeditionModule {
  id: string;
  description: string;
  dependsOn: string[];
}

export type EforgeResult = { status: 'completed' | 'failed'; summary: string };

export interface ClarificationQuestion {
  id: string;
  question: string;
  context?: string;
  options?: string[];
  default?: string;
}

export interface ReviewIssue {
  severity: 'critical' | 'warning' | 'suggestion';
  category: string;
  file: string;
  line?: number;
  description: string;
  fix?: string;
}

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
  plans: Array<{ id: string; name: string; dependsOn: string[]; branch: string }>;
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
  worktreeBase: string;
  plans: Record<string, PlanState>;
  completedPlans: string[];
}

export interface AgentResultData {
  durationMs: number;
  durationApiMs: number;
  numTurns: number;
  totalCostUsd: number;
  usage: { input: number; output: number; total: number };
  /** Per-model token and cost breakdown, keyed by model name */
  modelUsage: Record<string, { inputTokens: number; outputTokens: number; costUSD: number }>;
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
}

export interface AdoptOptions {
  verbose?: boolean;
  name?: string;
  cwd?: string;
  abortController?: AbortController;
  /** Skip the plan review cycle after adoption */
  skipReview?: boolean;
  /** Explicit validation commands for orchestration.yaml */
  validate?: string[];
  /** Run without approval gates (used when delegating to planner for excursion/expedition) */
  auto?: boolean;
}

export interface EforgeStatus {
  running: boolean;
  setName?: string;
  plans: Record<string, PlanState['status']>;
  completedPlans: string[];
}

export type EforgeEvent = { sessionId?: string } & (
  // Session lifecycle (one per eforge invocation, wraps all phases)
  | { type: 'session:start'; sessionId: string; timestamp: string }
  | { type: 'session:end'; sessionId: string; result: EforgeResult; timestamp: string }

  // Phase lifecycle (one per compile/build/adopt phase)
  | { type: 'phase:start'; runId: string; planSet: string; command: 'compile' | 'build' | 'adopt'; timestamp: string }
  | { type: 'phase:end'; runId: string; result: EforgeResult; timestamp: string }

  // Planning
  | { type: 'plan:start'; source: string }
  | { type: 'plan:scope'; assessment: ScopeAssessment; justification: string }
  | { type: 'plan:clarification'; questions: ClarificationQuestion[] }
  | { type: 'plan:clarification:answer'; answers: Record<string, string> }
  | { type: 'plan:progress'; message: string }
  | { type: 'plan:complete'; plans: PlanFile[] }

  // Plan review (after planning phase)
  | { type: 'plan:review:start' }
  | { type: 'plan:review:complete'; issues: ReviewIssue[] }
  | { type: 'plan:evaluate:start' }
  | { type: 'plan:evaluate:complete'; accepted: number; rejected: number }

  // Cohesion review (expedition cross-module validation)
  | { type: 'plan:cohesion:start' }
  | { type: 'plan:cohesion:complete'; issues: ReviewIssue[] }
  | { type: 'plan:cohesion:evaluate:start' }
  | { type: 'plan:cohesion:evaluate:complete'; accepted: number; rejected: number }

  // Building (per-plan)
  | { type: 'build:start'; planId: string }
  | { type: 'build:implement:start'; planId: string }
  | { type: 'build:implement:progress'; planId: string; message: string }
  | { type: 'build:implement:complete'; planId: string }
  | { type: 'build:files_changed'; planId: string; files: string[] }
  | { type: 'build:review:start'; planId: string }
  | { type: 'build:review:complete'; planId: string; issues: ReviewIssue[] }
  | { type: 'build:evaluate:start'; planId: string }
  | { type: 'build:evaluate:complete'; planId: string; accepted: number; rejected: number }
  | { type: 'build:complete'; planId: string }
  | { type: 'build:failed'; planId: string; error: string }

  // Orchestration
  | { type: 'wave:start'; wave: number; planIds: string[] }
  | { type: 'wave:complete'; wave: number }
  | { type: 'merge:start'; planId: string }
  | { type: 'merge:complete'; planId: string }

  // Expedition planning phases
  | { type: 'expedition:architecture:complete'; modules: ExpeditionModule[] }
  | { type: 'expedition:module:start'; moduleId: string }
  | { type: 'expedition:module:complete'; moduleId: string }
  | { type: 'expedition:compile:start' }
  | { type: 'expedition:compile:complete'; plans: PlanFile[] }

  // Agent lifecycle (emitted by backend for every agent invocation)
  | { type: 'agent:start'; planId?: string; agentId: string; agent: AgentRole; timestamp?: string }
  | { type: 'agent:stop'; planId?: string; agentId: string; agent: AgentRole; error?: string; timestamp?: string }

  // Agent-level (verbose streaming)
  | { type: 'agent:message'; planId?: string; agent: AgentRole; content: string }
  | { type: 'agent:tool_use'; planId?: string; agent: AgentRole; tool: string; toolUseId: string; input: unknown }
  | { type: 'agent:tool_result'; planId?: string; agent: AgentRole; tool: string; toolUseId: string; output: string }
  | { type: 'agent:result'; planId?: string; agent: AgentRole; result: AgentResultData }

  // Validation (post-merge)
  | { type: 'validation:start'; commands: string[] }
  | { type: 'validation:command:start'; command: string }
  | { type: 'validation:command:complete'; command: string; exitCode: number; output: string }
  | { type: 'validation:complete'; passed: boolean }
  | { type: 'validation:fix:start'; attempt: number; maxAttempts: number }
  | { type: 'validation:fix:complete'; attempt: number }

  // Cleanup (post-build)
  | { type: 'cleanup:start'; planSet: string }
  | { type: 'cleanup:complete'; planSet: string }

  // User interaction
  | { type: 'approval:needed'; planId?: string; action: string; details: string }
  | { type: 'approval:response'; approved: boolean }
);

/** Agent event types that runners always yield (not gated on verbose). */
export function isAlwaysYieldedAgentEvent(event: EforgeEvent): boolean {
  return event.type === 'agent:start'
    || event.type === 'agent:stop'
    || event.type === 'agent:result'
    || event.type === 'agent:tool_use'
    || event.type === 'agent:tool_result';
}

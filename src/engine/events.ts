// ForgeEvent discriminated union and all supporting types

export const ORCHESTRATION_MODES = ['errand', 'excursion', 'expedition'] as const;
export const SCOPE_ASSESSMENTS = ['complete', ...ORCHESTRATION_MODES] as const;
export type ScopeAssessment = (typeof SCOPE_ASSESSMENTS)[number];

export type AgentRole = 'planner' | 'builder' | 'reviewer' | 'evaluator' | 'module-planner';

export interface ExpeditionModule {
  id: string;
  description: string;
  dependsOn: string[];
}

export type ForgeResult = { status: 'completed' | 'failed'; summary: string };

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
}

export interface PlanState {
  status: 'pending' | 'running' | 'completed' | 'failed' | 'blocked' | 'merged';
  worktreePath?: string;
  branch: string;
  dependsOn: string[];
  merged: boolean;
  error?: string;
}

export interface ForgeState {
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

export interface PlanOptions {
  auto?: boolean;
  verbose?: boolean;
  name?: string;
  cwd?: string;
}

export interface BuildOptions {
  auto?: boolean;
  verbose?: boolean;
  dryRun?: boolean;
  cwd?: string;
}

export interface ReviewOptions {
  auto?: boolean;
  verbose?: boolean;
  cwd?: string;
}

export interface ForgeStatus {
  running: boolean;
  setName?: string;
  plans: Record<string, PlanState['status']>;
  completedPlans: string[];
}

export type ForgeEvent =
  // Lifecycle
  | { type: 'forge:start'; runId: string; planSet: string; command: 'plan' | 'build' | 'review'; timestamp: string }
  | { type: 'forge:end'; runId: string; result: ForgeResult; timestamp: string }

  // Planning
  | { type: 'plan:start'; source: string }
  | { type: 'plan:scope'; assessment: ScopeAssessment; justification: string }
  | { type: 'plan:clarification'; questions: ClarificationQuestion[] }
  | { type: 'plan:clarification:answer'; answers: Record<string, string> }
  | { type: 'plan:progress'; message: string }
  | { type: 'plan:complete'; plans: PlanFile[] }

  // Building (per-plan)
  | { type: 'build:start'; planId: string }
  | { type: 'build:implement:start'; planId: string }
  | { type: 'build:implement:progress'; planId: string; message: string }
  | { type: 'build:implement:complete'; planId: string }
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

  // Agent-level (verbose streaming)
  | { type: 'agent:message'; planId?: string; agent: AgentRole; content: string }
  | { type: 'agent:tool_use'; planId?: string; agent: AgentRole; tool: string; input: unknown }
  | { type: 'agent:tool_result'; planId?: string; agent: AgentRole; tool: string; output: string }
  | { type: 'agent:result'; planId?: string; agent: AgentRole; result: AgentResultData }

  // User interaction
  | { type: 'approval:needed'; planId?: string; action: string; details: string }
  | { type: 'approval:response'; approved: boolean };

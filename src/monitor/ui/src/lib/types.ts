// Re-export key types from engine events
export type {
  EforgeEvent,
  AgentRole,
  AgentResultData,
  EforgeResult,
  ClarificationQuestion,
  ReviewIssue,
  PlanFile,
  OrchestrationConfig,
  PlanState,
  EforgeState,
  ExpeditionModule,
} from '../../../../engine/events.js';

export type ConnectionStatus = 'connected' | 'connecting' | 'disconnected';

export type PipelineStage = 'plan' | 'implement' | 'doc-update' | 'review' | 'evaluate' | 'complete' | 'failed';

export type PlanType = 'architecture' | 'module' | 'plan';

export interface PlanData {
  id: string;
  name: string;
  body: string;
  dependsOn?: string[];
  type?: PlanType;
}

export interface PlanStatus {
  planId: string;
  stage: PipelineStage;
}


export interface QueueItem {
  id: string;
  title: string;
  status: string;
  priority?: number;
  created?: string;
  dependsOn?: string[];
}

export interface RunInfo {
  id: string;
  planSet: string;
  command: string;
  status: string;
  startedAt: string;
  completedAt?: string;
  cwd: string;
  sessionId?: string;
}

export type BuildStageSpec = string | string[];

export interface ReviewProfileConfig {
  strategy: string;
  perspectives: string[];
  maxRounds: number;
  evaluatorStrictness: string;
}

export interface ProfileConfig {
  description: string;
  extends?: string;
  compile: string[];
  build: BuildStageSpec[];
  agents: Record<string, unknown>;
  review: ReviewProfileConfig;
}

export interface ProfileInfo {
  profileName: string;
  rationale: string;
  config: ProfileConfig;
}

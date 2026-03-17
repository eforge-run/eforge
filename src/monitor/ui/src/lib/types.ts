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
  ScopeAssessment,
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

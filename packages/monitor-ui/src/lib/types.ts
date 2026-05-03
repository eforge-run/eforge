// Re-export key types from @eforge-build/client wire events
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
} from '@eforge-build/client/browser';

// Shared types owned by @eforge-build/client; re-export so every existing
// `@/lib/types` importer continues to resolve the same names.
import type { BuildStageSpec, ReviewProfileConfig } from '@eforge-build/client/browser';
export type { BuildStageSpec, ReviewProfileConfig };

export type ConnectionStatus = 'connected' | 'connecting' | 'disconnected';

export type PipelineStage = 'plan' | 'implement' | 'doc-author' | 'doc-sync' | 'test' | 'review' | 'evaluate' | 'complete' | 'failed';

export type PlanType = 'architecture' | 'module' | 'plan';

export interface PlanData {
  id: string;
  name: string;
  body: string;
  dependsOn?: string[];
  type?: PlanType;
  build?: BuildStageSpec[];
  review?: ReviewProfileConfig;
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

export type SessionProfile = {
  profileName: string | null;
  source: 'local' | 'project' | 'user-local' | 'missing' | 'none';
  scope: 'local' | 'project' | 'user' | null;
  config: unknown | null;
};

export interface SessionMetadata {
  planCount: number | null;
  baseProfile: string | null;
}

// EforgeEvent discriminated union and all supporting types
//
// Wire-protocol types are defined in @eforge-build/client and re-exported
// here so engine code continues to import from './events.js' without changes.

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
  PrdValidationGap,
  TestIssue,
  BuildFailureSummary,
  LandedCommit,
  PlanSummaryEntry,
  FailingPlanEntry,
  ReconciliationReport,
  EforgeStatus,
  QueueEvent,
  StalenessVerdict,
  RecoveryVerdict,
  ReviewPerspective,
  AgentTerminalSubtype,
  ShardScope,
  PipelineComposition,
} from '@eforge-build/client';

export {
  ORCHESTRATION_MODES,
  SEVERITY_ORDER,
  isAlwaysYieldedAgentEvent,
} from '@eforge-build/client';

// Engine-only types not part of the wire protocol:

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

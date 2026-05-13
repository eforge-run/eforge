/**
 * Wire event types for the eforge daemon SSE stream.
 *
 * Types are derived from TypeBox schemas in `events.schemas.ts` (the wire-protocol
 * source of truth) and re-exported here so engine code continues to import from
 * './events.js' without changes.
 *
 * The engine re-exports these types from `@eforge-build/client` so callers
 * that already depend on the client do not need to add the engine as a
 * dependency.
 */

export type {
  EforgeEvent,
  DaemonRunUpsertEvent,
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
  BuildDecision,
  PlanningDecision,
  PlanningDecisionEvent,
} from './events.schemas.js';

export {
  ORCHESTRATION_MODES,
  SEVERITY_ORDER,
  isAlwaysYieldedAgentEvent,
  REVIEW_PERSPECTIVES,
  BuildDecisionSchema,
  PlanningDecisionSchema,
  safeParseEforgeEvent,
  parseEforgeEvent,
  safeParseDaemonStreamSnapshot,
  safeParseSessionStreamSnapshot,
} from './events.schemas.js';

export { EforgeEventSchema } from './events.schemas.js';

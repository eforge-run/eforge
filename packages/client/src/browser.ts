/**
 * Browser-safe entrypoint for @eforge-build/client.
 *
 * Exports everything from the main index that is safe to use in a browser
 * context. Specifically excludes:
 *   - lockfile.ts  (uses node:fs)
 *   - daemon-client.ts  (uses node:child_process, node:fs)
 *   - profile-utils.ts  (uses node:fs via daemon-client)
 *
 * session-stream.ts is safe: it branches on `typeof EventSource !== 'undefined'`
 * at runtime, using fetch in browser contexts. The `node:http` import in
 * session-stream.ts is only exercised on the Node path.
 */

export { API_ROUTES, buildPath } from './routes.js';
export type {
  ApiRoute,
  EnqueueRequest,
  AutoBuildSetRequest,
  StopDaemonRequest,
  VersionResponse,
  RecoverRequest,
  RecoverResponse,
  ReadSidecarRequest,
  RecoveryVerdictSidecar,
  ReadSidecarResponse,
  ApplyRecoveryRequest,
  ApplyRecoveryResponse,
  SessionPlanStatusWire,
  PlanningTypeWire,
  PlanningDepthWire,
  SkippedDimensionWire,
  SessionPlanListEntryWire,
  SessionPlanDataWire,
  SessionPlanListResponse,
  SessionPlanShowResponse,
  SessionPlanCreateRequest,
  SessionPlanCreateResponse,
  SessionPlanSetSectionRequest,
  SessionPlanSetSectionResponse,
  SessionPlanSkipDimensionRequest,
  SessionPlanSkipDimensionResponse,
  SessionPlanSetStatusRequest,
  SessionPlanSetStatusResponse,
  SessionPlanSelectDimensionsRequest,
  SessionPlanSelectDimensionsResponse,
  SessionPlanReadinessResponse,
  SessionPlanMigrateLegacyRequest,
  SessionPlanMigrateLegacyResponse,
} from './routes.js';

export type {
  HealthResponse,
  AutoBuildState,
  ProjectContext,
  ConfigShowResponse,
  ConfigValidateResponse,
  QueueItem,
  SessionMetadata,
  RunInfo,
  LatestRunResponse,
  BuildStageSpec,
  ReviewProfileConfig,
  OrchestrationResponse,
  RunSummary,
  RunState,
  PlanInfo,
  PlansResponse,
  DiffBulkResponse,
  DiffSingleResponse,
  DiffResponse,
  EnqueueResponse,
  CancelResponse,
  StopDaemonResponse,
  KeepAliveResponse,
  AgentRuntimeProfileInfo,
  AgentRuntimeProfileSource,
  ProfileListRequest,
  ProfileListResponse,
  ProfileShowResponse,
  ProfileUseRequest,
  ProfileUseResponse,
  ProfileCreateRequest,
  ProfileCreateResponse,
  ProfileDeleteRequest,
  ProfileDeleteResponse,
  ModelProvidersResponse,
  ModelInfo,
  ModelListResponse,
} from './types.js';

export { subscribeToSession, parseSseChunk } from './session-stream.js';
export type {
  SessionSummary,
  SubscribeOptions,
  DaemonStreamEvent,
  ParsedSseBlock,
} from './session-stream.js';

export { eventToProgress } from './event-to-progress.js';
export type { FollowCounters, ProgressUpdate } from './event-to-progress.js';

export { DAEMON_API_VERSION, verifyApiVersion, clearApiVersionCache } from './api-version.js';

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
} from './events.js';

export { ORCHESTRATION_MODES, SEVERITY_ORDER, isAlwaysYieldedAgentEvent } from './events.js';

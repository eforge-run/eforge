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
} from './routes.js';

export {
  apiEnqueue,
  apiCancel,
  apiGetQueue,
  apiGetRuns,
  apiGetLatestRun,
  apiGetLatestRunIfRunning,
  apiGetRunSummary,
  apiGetRunSummaryIfRunning,
  apiGetRunState,
  apiGetPlans,
  apiGetDiff,
  apiGetOrchestration,
  apiGetSessionMetadata,
} from './api/queue.js';

export {
  apiListProfiles,
  apiShowProfile,
  apiUseProfile,
  apiCreateProfile,
  apiDeleteProfile,
} from './api/profile.js';

export {
  apiHealth,
  apiKeepAlive,
  apiGetProjectContext,
  apiGetAutoBuild,
  apiSetAutoBuild,
} from './api/status.js';

export {
  apiShowConfig,
  apiShowConfigIfRunning,
  apiValidateConfig,
  apiValidateConfigIfRunning,
} from './api/config.js';

export { apiListModelProviders, apiListModels } from './api/models.js';

export { apiStopDaemon } from './api/daemon.js';

export { apiRecover } from './api/recover.js';

export { apiReadRecoverySidecar } from './api/recovery-sidecar.js';

export { apiApplyRecovery } from './api/apply-recovery.js';

export type { ApplyRecoveryRequest, ApplyRecoveryResponse } from './routes.js';

export {
  type LockfileData,
  LOCKFILE_NAME,
  LOCKFILE_POLL_INTERVAL_MS,
  LOCKFILE_POLL_TIMEOUT_MS,
  readLockfile,
  isPidAlive,
  isServerAlive,
  lockfilePath,
  writeLockfile,
  updateLockfile,
  removeLockfile,
  killPidIfAlive,
} from './lockfile.js';

export {
  DAEMON_START_TIMEOUT_MS,
  DAEMON_POLL_INTERVAL_MS,
  sleep,
  ensureDaemon,
  daemonRequest,
  daemonRequestIfRunning,
  isAgentWorktreeCwd,
  DaemonInWorktreeError,
} from './daemon-client.js';

export { DAEMON_API_VERSION, verifyApiVersion, clearApiVersionCache } from './api-version.js';

export { sanitizeProfileName, parseRawConfigLegacy } from './profile-utils.js';

export { subscribeToSession, parseSseChunk } from './session-stream.js';
export type {
  SessionSummary,
  SubscribeOptions,
  DaemonStreamEvent,
  ParsedSseBlock,
} from './session-stream.js';

export { eventToProgress } from './event-to-progress.js';
export type { FollowCounters, ProgressUpdate } from './event-to-progress.js';

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
  BackendProfileInfo,
  BackendProfileSource,
  BackendListRequest,
  BackendListResponse,
  BackendShowResponse,
  BackendUseRequest,
  BackendUseResponse,
  BackendCreateRequest,
  BackendCreateResponse,
  BackendDeleteRequest,
  BackendDeleteResponse,
  ModelProvidersResponse,
  ModelInfo,
  ModelListResponse,
} from './types.js';

export { API_ROUTES, buildPath } from './routes.js';
export type { ApiRoute, EnqueueRequest, AutoBuildSetRequest, StopDaemonRequest } from './routes.js';

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
  apiListBackends,
  apiShowBackend,
  apiUseBackend,
  apiCreateBackend,
  apiDeleteBackend,
} from './api/backend.js';

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

export { DAEMON_API_VERSION } from './api-version.js';

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

// GET /api/health
export interface HealthResponse {
  status: 'ok';
  pid: number;
}

// GET /api/auto-build, POST /api/auto-build
export interface AutoBuildState {
  enabled: boolean;
  watcher: {
    running: boolean;
    pid: number | null;
    sessionId: string | null;
  };
}

// GET /api/project-context
export interface ProjectContext {
  cwd: string | null;
  gitRemote: string | null;
}

// GET /api/config/show - opaque, full EforgeConfig has engine deps
export type ConfigShowResponse = unknown;

// GET /api/config/validate
export interface ConfigValidateResponse {
  configFound: boolean;
  valid: boolean;
  errors?: string[];
  config?: unknown;
}

// GET /api/queue (array of these)
export interface QueueItem {
  id: string;
  title: string;
  status: string;
  priority?: number;
  created?: string;
  dependsOn?: string[];
}

// GET /api/session-metadata (values in Record<string, SessionMetadata>)
export interface SessionMetadata {
  planCount: number | null;
  baseProfile: string | null;
  backend: string | null;
}

// GET /api/runs (array of these)
export interface RunInfo {
  id: string;
  sessionId?: string;
  planSet: string;
  command: string;
  status: string;
  startedAt: string;
  completedAt?: string;
  cwd: string;
  pid?: number;
}

// GET /api/latest-run
export interface LatestRunResponse {
  sessionId: string | null;
  runId: string | null;
}

// Types used within OrchestrationResponse
export type BuildStageSpec = string | string[];

export interface ReviewProfileConfig {
  strategy: string;
  perspectives: string[];
  maxRounds: number;
  evaluatorStrictness: string;
}

// GET /api/orchestration/:id
export interface OrchestrationResponse {
  plans: Array<{
    id: string;
    name: string;
    dependsOn: string[];
    branch: string;
    build?: BuildStageSpec[];
    review?: ReviewProfileConfig;
  }>;
  mode: string | null;
} // Returns null when no plan:complete event exists

// GET /api/run-summary/:id
export interface RunSummary {
  sessionId: string;
  status: 'unknown' | 'running' | 'failed' | 'completed';
  runs: Array<{
    id: string;
    command: string;
    status: string;
    startedAt: string;
    completedAt: string | null;
  }>;
  plans: Array<{
    id: string;
    status: 'running' | 'completed' | 'failed';
    branch: string | null;
    dependsOn: string[];
  }>;
  currentPhase: string | null;
  currentAgent: string | null;
  eventCounts: {
    total: number;
    errors: number;
  };
  duration: {
    startedAt: string | null;
    completedAt: string | null;
    seconds: number | null;
  };
}

// GET /api/run-state/:id
export interface RunState {
  status: 'unknown' | 'running' | 'failed' | 'completed';
  events: Array<{
    id: number;
    runId: string;
    type: string;
    planId?: string;
    agent?: string;
    data: string;
    timestamp: string;
  }>;
}

// GET /api/plans/:id (array of these)
export interface PlanInfo {
  id: string;
  name: string;
  body: string;
  dependsOn: string[];
  type: 'architecture' | 'module' | 'plan';
  build?: BuildStageSpec[];
  review?: ReviewProfileConfig;
}

// Type alias for the plans endpoint response
export type PlansResponse = PlanInfo[];

// GET /api/diff/:sessionId/:planId (bulk)
export interface DiffBulkResponse {
  files: Array<{
    path: string;
    diff: string;
  }>;
}

// GET /api/diff/:sessionId/:planId?file=path (single)
export interface DiffSingleResponse {
  diff: string | null;
}

// Union for the diff endpoint
export type DiffResponse = DiffBulkResponse | DiffSingleResponse;

// POST /api/enqueue
export interface EnqueueResponse {
  sessionId: string;
  pid: number;
  autoBuild: boolean;
}

// POST /api/cancel/:id
export interface CancelResponse {
  status: 'cancelled';
  sessionId: string;
}

// POST /api/daemon/stop
export interface StopDaemonResponse {
  status: 'stopping';
  force: boolean;
}

// POST /api/keep-alive
export interface KeepAliveResponse {
  status: 'ok';
}

// ---------------------------------------------------------------------------
// Backend profile management (DAEMON_API_VERSION 2)
// ---------------------------------------------------------------------------

/** A single backend profile entry returned by the list endpoint. */
export interface BackendProfileInfo {
  name: string;
  backend: 'claude-sdk' | 'pi' | undefined;
  path: string;
}

/** Source of the active backend profile resolution. */
export type BackendProfileSource = 'local' | 'team' | 'missing' | 'none';

// GET /api/backend/list
export interface BackendListResponse {
  profiles: BackendProfileInfo[];
  active: string | null;
  source: BackendProfileSource;
}

// GET /api/backend/show
export interface BackendShowResponse {
  active: string | null;
  source: BackendProfileSource;
  resolved: {
    backend: 'claude-sdk' | 'pi' | undefined;
    /** The parsed profile partial config. Opaque to the client. */
    profile: unknown | null;
  };
}

// POST /api/backend/use
export interface BackendUseRequest {
  name: string;
}

export interface BackendUseResponse {
  active: string;
}

// POST /api/backend/create
export interface BackendCreateRequest {
  name: string;
  backend: 'claude-sdk' | 'pi';
  /** Optional pi config block — opaque to the client. */
  pi?: unknown;
  /** Optional agents config block — opaque to the client. */
  agents?: unknown;
  overwrite?: boolean;
}

export interface BackendCreateResponse {
  path: string;
}

// DELETE /api/backend/:name
export interface BackendDeleteRequest {
  force?: boolean;
}

export interface BackendDeleteResponse {
  deleted: string;
}

// ---------------------------------------------------------------------------
// Model listing (DAEMON_API_VERSION 2)
// ---------------------------------------------------------------------------

// GET /api/models/providers?backend=pi|claude-sdk
export interface ModelProvidersResponse {
  providers: string[];
}

/** A single model entry returned by the model-listing endpoints. */
export interface ModelInfo {
  id: string;
  provider?: string;
  contextWindow?: number;
  releasedAt?: string;
  deprecated?: boolean;
}

// GET /api/models/list?backend=pi|claude-sdk&provider=<optional>
export interface ModelListResponse {
  models: ModelInfo[];
}

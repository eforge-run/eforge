import type { EforgeEvent } from './events.js';

// GET /api/health
export interface HealthResponse {
  status: 'ok';
  pid: number;
}

// GET /api/auto-build, POST /api/auto-build
// --- eforge:region plan-01-supervisor-foundation ---
export type AutoBuildDesired = 'enabled' | 'disabled';
export type AutoBuildRuntimeMode =
  | 'disabled'
  | 'starting'
  | 'running'
  | 'paused'
  | 'stopping'
  | 'restarting'
  | 'faulted';

export interface AutoBuildSchedulerState {
  alive: boolean;
  paused: boolean;
  lastMutationReason?: string;
}

export interface AutoBuildTransitionDetail {
  at: string;
  previousMode: AutoBuildRuntimeMode;
  nextMode: AutoBuildRuntimeMode;
  desired: AutoBuildDesired;
  reason?: string;
  source: string;
}
// --- eforge:endregion plan-01-supervisor-foundation ---

export interface AutoBuildState {
  enabled: boolean;
  watcher: {
    running: boolean;
    pid: number | null;
    sessionId: string | null;
  };
  // --- eforge:region plan-01-supervisor-foundation ---
  desired?: AutoBuildDesired;
  mode?: AutoBuildRuntimeMode;
  scheduler?: AutoBuildSchedulerState;
  lastTransition?: AutoBuildTransitionDetail;
  reason?: string;
  // --- eforge:endregion plan-01-supervisor-foundation ---
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

// --- eforge:region plan-02-extension-tooling-surfaces ---
export type ExtensionScope = 'user' | 'project-team' | 'project-local' | 'external';
export type ExtensionSource = 'auto' | 'explicit';
export type ExtensionStatus = 'pending' | 'loaded' | 'shadowed' | 'skipped' | 'error' | 'excluded';
export type ExtensionDiagnosticSeverity = 'warning' | 'error';
export type ExtensionFormat = 'js' | 'mjs' | 'ts' | 'mts';
export type ExtensionLayout = 'file' | 'directory';
export type ExtensionTrust = 'trusted' | 'untrusted';
// --- eforge:region plan-01-extension-management-api ---
export type ExtensionScaffoldScope = 'local' | 'project' | 'user';
export type ExtensionScaffoldTemplate = 'event-logger' | 'blank';
// --- eforge:endregion plan-01-extension-management-api ---

export interface ExtensionDiagnostic {
  severity: ExtensionDiagnosticSeverity;
  code: string;
  message: string;
  name?: string;
  path?: string;
  scope?: ExtensionScope;
  source?: ExtensionSource;
}

export interface ExtensionShadow {
  name: string;
  path: string;
  entrypoint?: string;
  scope: Exclude<ExtensionScope, 'external'>;
  format?: ExtensionFormat;
  layout?: ExtensionLayout;
}

export interface ExtensionRegistrationSummary {
  eventHooks: number;
  agentRunHooks: number;
  policyGates: number;
  profileRouters: number;
  inputSources: number;
  reviewerPerspectives: number;
  validationProviders: number;
  tools: number;
}

export interface ExtensionEntry {
  name: string;
  path: string;
  entrypoint?: string;
  scope: ExtensionScope;
  source: ExtensionSource;
  status: ExtensionStatus;
  // --- eforge:region plan-01-extension-management-api ---
  enabled?: boolean;
  // --- eforge:endregion plan-01-extension-management-api ---
  trust?: ExtensionTrust;
  format?: ExtensionFormat;
  layout?: ExtensionLayout;
  strategy?: string;
  shadows: ExtensionShadow[];
  registrations: ExtensionRegistrationSummary;
  diagnostics: ExtensionDiagnostic[];
}

export interface ExtensionListResponse {
  extensions: ExtensionEntry[];
  diagnostics: ExtensionDiagnostic[];
  totals: ExtensionRegistrationSummary;
}

export interface ExtensionShowResponse {
  extension: ExtensionEntry;
}

export interface ExtensionValidateResponse {
  valid: boolean;
  extensions: ExtensionEntry[];
  diagnostics: ExtensionDiagnostic[];
}

// --- eforge:region plan-01-engine-daemon-extension-replay ---
export interface ExtensionTestRequest {
  name?: string;
  path?: string;
  fixture?: string;
  run?: 'latest' | string;
  event?: string;
}

export interface ExtensionTestSource {
  kind: 'none' | 'fixture' | 'run';
  fixture?: string;
  run?: string;
  sessionId?: string;
  event?: string;
}

export interface ExtensionTestReplayCounts {
  inputEventCount: number;
  filteredEventCount: number;
  emittedEventCount: number;
  diagnosticEventCount: number;
}

export interface ExtensionTestMatch {
  eventIndex: number;
  eventType: string;
  extensionName: string;
  extensionPath: string;
  pattern: string;
}

export type ExtensionTestDiagnosticEvent = Extract<
  EforgeEvent,
  { type: 'extension:event-handler:failed' | 'extension:event-handler:timeout' }
>;

export type ExtensionTestDeferredRegistrationFamily =
  | 'agentRunHooks'
  | 'policyGates'
  | 'profileRouters'
  | 'inputSources'
  | 'reviewerPerspectives'
  | 'validationProviders'
  | 'tools';

export interface ExtensionTestDeferredRegistrationSummary {
  family: ExtensionTestDeferredRegistrationFamily;
  count: number;
  extensions: Array<{ name: string; path: string; count: number }>;
}

export interface ExtensionTestResponse {
  valid: boolean;
  source: ExtensionTestSource;
  extensions: ExtensionEntry[];
  diagnostics: ExtensionDiagnostic[];
  replay: ExtensionTestReplayCounts;
  matches: ExtensionTestMatch[];
  emittedDiagnostics: ExtensionTestDiagnosticEvent[];
  deferredRegistrations: ExtensionTestDeferredRegistrationSummary[];
}
// --- eforge:endregion plan-01-engine-daemon-extension-replay ---

// --- eforge:region plan-01-extension-management-api ---
export interface ExtensionNewRequest {
  name: string;
  scope?: ExtensionScaffoldScope;
  template?: ExtensionScaffoldTemplate;
  force?: boolean;
}

export interface ExtensionNewResponse {
  name: string;
  template: ExtensionScaffoldTemplate;
  requestScope: ExtensionScaffoldScope;
  scope: Exclude<ExtensionScope, 'external'>;
  configDir: string;
  scopeDir: string;
  extensionsDir: string;
  path: string;
  created: true;
  overwritten: boolean;
  message: string;
}

export interface ExtensionReloadWatcherMetadata {
  wasRunning: boolean;
  restarted: boolean;
  running: boolean;
  previousSessionId: string | null;
  sessionId: string | null;
  message: string;
}

export interface ExtensionReloadResponse extends ExtensionListResponse, ExtensionReloadWatcherMetadata {
  watcher: ExtensionReloadWatcherMetadata;
}
// --- eforge:endregion plan-01-extension-management-api ---
// --- eforge:endregion plan-02-extension-tooling-surfaces ---

// GET /api/queue (array of these)
export interface QueueItem {
  id: string;
  title: string;
  status: string;
  priority?: number;
  created?: string;
  dependsOn?: string[];
  /**
   * Recovery verdict for failed items. Populated by the daemon when a
   * `<prdId>.recovery.json` sidecar exists in the `failed/` directory.
   * Absent when no sidecar is present or the sidecar is malformed.
   */
  recoveryVerdict?: {
    verdict: 'retry' | 'split' | 'abandon' | 'manual';
    confidence: 'low' | 'medium' | 'high';
  };
}

// GET /api/session-metadata (values in Record<string, SessionMetadata>)
export interface SessionMetadata {
  planCount: number | null;
  baseProfile: string | null;
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

// Types used within orchestration and plan endpoints.
// Single owner: these types cross the daemon HTTP boundary and are re-exported
// by @eforge-build/engine for engine-internal use. Do not duplicate elsewhere.
export type BuildStageSpec = string | string[];

export interface ReviewProfileConfig {
  strategy: 'auto' | 'single' | 'parallel';
  perspectives: ('code' | 'security' | 'api' | 'docs' | 'test' | 'verify')[];
  maxRounds: number;
  evaluatorStrictness: 'strict' | 'standard' | 'lenient';
}

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
    status: 'pending' | 'running' | 'completed' | 'failed';
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
// Agent runtime profile management (renamed from backend in DAEMON_API_VERSION 10)
// ---------------------------------------------------------------------------

/** Optional descriptive metadata carried by agent runtime profile files. */
export interface ProfileMetadata {
  description?: string;
  whenToUse?: string[];
  tags?: string[];
}

/** A single agent runtime profile entry returned by the list endpoint. */
export interface AgentRuntimeProfileInfo {
  name: string;
  harness: 'claude-sdk' | 'pi' | undefined;
  path: string;
  scope: 'local' | 'project' | 'user';
  shadowedBy?: 'local' | 'project';
  metadata?: ProfileMetadata;
}

/** Source of the active agent runtime profile resolution. */
export type AgentRuntimeProfileSource = 'local' | 'project' | 'user-local' | 'missing' | 'none';

// GET /api/profile/list
export interface ProfileListResponse {
  profiles: AgentRuntimeProfileInfo[];
  active: string | null;
  source: AgentRuntimeProfileSource;
}

// GET /api/profile/show
export interface ProfileShowResponse {
  active: string | null;
  source: AgentRuntimeProfileSource;
  resolved: {
    harness: 'claude-sdk' | 'pi' | undefined;
    /** The parsed profile partial config. Opaque to the client. */
    profile: unknown | null;
    scope?: 'local' | 'project' | 'user';
    metadata?: ProfileMetadata;
  };
}

/** Optional scope filter for the list endpoint. */
export interface ProfileListRequest {
  scope?: 'local' | 'project' | 'user' | 'all';
}

// POST /api/profile/use
export interface ProfileUseRequest {
  name: string;
  scope?: 'local' | 'project' | 'user';
}

export interface ProfileUseResponse {
  active: string;
}

// POST /api/profile/create
export interface ProfileCreateRequest {
  name: string;
  /**
   * Agents config block — opaque to the client. Should carry tier recipes
   * under `agents.tiers` (each with self-contained harness + model + effort).
   */
  agents?: unknown;
  metadata?: ProfileMetadata;
  overwrite?: boolean;
  scope?: 'local' | 'project' | 'user';
}

export interface ProfileCreateResponse {
  path: string;
}

// DELETE /api/profile/:name
export interface ProfileDeleteRequest {
  force?: boolean;
  scope?: 'local' | 'project' | 'user';
}

export interface ProfileDeleteResponse {
  deleted: string;
}

// ---------------------------------------------------------------------------
// Model listing (DAEMON_API_VERSION 10)
// ---------------------------------------------------------------------------

// GET /api/models/providers?harness=pi|claude-sdk
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

// GET /api/models/list?harness=pi|claude-sdk&provider=<optional>
export interface ModelListResponse {
  models: ModelInfo[];
}

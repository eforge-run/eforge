/**
 * Missing request type shapes not yet declared in types.ts.
 * Re-export from index so callers can import the request/response pair together.
 */

/** POST /api/enqueue */
export interface EnqueueRequest {
  source: string;
  flags?: string[];
}

/** POST /api/auto-build */
export interface AutoBuildSetRequest {
  enabled: boolean;
}

/** POST /api/daemon/stop */
export interface StopDaemonRequest {
  force?: boolean;
}

/** POST /api/recover */
export interface RecoverRequest {
  setName: string;
  prdId: string;
}

/** Response for POST /api/recover */
export interface RecoverResponse {
  sessionId: string;
  pid: number;
}

/** Query params for GET /api/recovery/sidecar */
export interface ReadSidecarRequest {
  prdId: string;
}

/**
 * JSON structure written by `eforge recover` into `<prdId>.recovery.json`.
 * Mirrors the shape produced by `writeRecoverySidecar` in the engine (schemaVersion: 1).
 */
export interface RecoveryVerdictSidecar {
  schemaVersion: number;
  generatedAt: string;
  summary: {
    prdId: string;
    setName: string;
    featureBranch: string;
    baseBranch: string;
    plans: Array<{ planId: string; status: string; mergedAt?: string; error?: string; terminalSubtype?: string }>;
    failingPlan: { planId: string; agentId?: string; agentRole?: string; errorMessage?: string; terminalSubtype?: string };
    landedCommits: Array<{ sha: string; subject: string; author: string; date: string }>;
    diffStat: string;
    modelsUsed: string[];
    failedAt: string;
  };
  verdict: {
    verdict: 'retry' | 'split' | 'abandon' | 'manual';
    confidence: 'low' | 'medium' | 'high';
    rationale: string;
    completedWork: string[];
    remainingWork: string[];
    risks: string[];
    suggestedSuccessorPrd?: string;
  };
  [key: string]: unknown;
}

/** Response for GET /api/recovery/sidecar */
export interface ReadSidecarResponse {
  markdown: string;
  json: RecoveryVerdictSidecar;
}

/** POST /api/recover/apply */
export interface ApplyRecoveryRequest {
  prdId: string;
}

/** Response for POST /api/recover/apply */
export interface ApplyRecoveryResponse {
  sessionId: string;
  pid: number;
}

/**
 * Central API route map for the eforge daemon HTTP API.
 *
 * Single source of truth for all `/api/...` path patterns. Consumers import
 * these constants instead of embedding literal strings, so a route rename
 * surfaces as a compile-time error everywhere.
 *
 * Patterns with `:param` placeholders are resolved at call-time with
 * `buildPath(pattern, params)`.
 */

export const API_ROUTES = {
  keepAlive: '/api/keep-alive',
  enqueue: '/api/enqueue',
  cancel: '/api/cancel/:sessionId',
  daemonStop: '/api/daemon/stop',
  autoBuildGet: '/api/auto-build',
  autoBuildSet: '/api/auto-build',
  profileList: '/api/profile/list',
  profileShow: '/api/profile/show',
  profileUse: '/api/profile/use',
  profileCreate: '/api/profile/create',
  profileDelete: '/api/profile/:name',
  modelProviders: '/api/models/providers',
  modelList: '/api/models/list',
  projectContext: '/api/project-context',
  health: '/api/health',
  version: '/api/version',
  configShow: '/api/config/show',
  configValidate: '/api/config/validate',
  queue: '/api/queue',
  sessionMetadata: '/api/session-metadata',
  runs: '/api/runs',
  latestRun: '/api/latest-run',
  events: '/api/events/:runId',
  orchestration: '/api/orchestration/:runId',
  runSummary: '/api/run-summary/:id',
  runState: '/api/run-state/:id',
  plans: '/api/plans/:runId',
  diff: '/api/diff/:sessionId/:planId',
  recover: '/api/recover',
  readRecoverySidecar: '/api/recovery/sidecar',
  applyRecovery: '/api/recover/apply',
  playbookList: '/api/playbook/list',
  playbookShow: '/api/playbook/show',
  playbookSave: '/api/playbook/save',
  playbookEnqueue: '/api/playbook/enqueue',
  playbookPromote: '/api/playbook/promote',
  playbookDemote: '/api/playbook/demote',
  playbookValidate: '/api/playbook/validate',
  playbookCopy: '/api/playbook/copy',
} as const;

/** Response body for GET /api/version */
export interface VersionResponse {
  version: number;
}

export type ApiRoute = (typeof API_ROUTES)[keyof typeof API_ROUTES];

/**
 * Resolve a route pattern with `:param` placeholders into a concrete path.
 *
 * @example
 * buildPath(API_ROUTES.cancel, { sessionId: 'abc-123' })
 * // => '/api/cancel/abc-123'
 */
export function buildPath(pattern: string, params: Record<string, string>): string {
  return Object.entries(params).reduce(
    (path, [key, value]) => path.replace(`:${key}`, encodeURIComponent(value)),
    pattern,
  );
}

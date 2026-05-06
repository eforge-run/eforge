/**
 * Typed helpers for queue-related daemon API endpoints.
 */

import { daemonRequest, daemonRequestIfRunning } from '../daemon-client.js';
import { API_ROUTES, buildPath } from '../routes.js';
import type {
  EnqueueResponse,
  CancelResponse,
  QueueItem,
  RunInfo,
  LatestRunResponse,
  RunSummary,
  RunState,
  PlansResponse,
  DiffResponse,
  SessionMetadata,
} from '../types.js';
import type { EnqueueRequest } from '../routes.js';

export function apiEnqueue(opts: { cwd: string; body: EnqueueRequest }) {
  return daemonRequest<EnqueueResponse>(opts.cwd, 'POST', API_ROUTES.enqueue, opts.body);
}

export function apiCancel(opts: { cwd: string; sessionId: string }) {
  return daemonRequest<CancelResponse>(
    opts.cwd,
    'POST',
    buildPath(API_ROUTES.cancel, { sessionId: opts.sessionId }),
  );
}

export function apiGetQueue(opts: { cwd: string }) {
  return daemonRequest<QueueItem[]>(opts.cwd, 'GET', API_ROUTES.queue);
}

export function apiGetRuns(opts: { cwd: string }) {
  return daemonRequest<RunInfo[]>(opts.cwd, 'GET', API_ROUTES.runs);
}

export function apiGetLatestRun(opts: { cwd: string }) {
  return daemonRequest<LatestRunResponse>(opts.cwd, 'GET', API_ROUTES.latestRun);
}

export function apiGetLatestRunIfRunning(opts: { cwd: string }) {
  return daemonRequestIfRunning<LatestRunResponse>(opts.cwd, 'GET', API_ROUTES.latestRun);
}

export function apiGetRunSummary(opts: { cwd: string; id: string }) {
  return daemonRequest<RunSummary>(
    opts.cwd,
    'GET',
    buildPath(API_ROUTES.runSummary, { id: opts.id }),
  );
}

export function apiGetRunSummaryIfRunning(opts: { cwd: string; id: string }) {
  return daemonRequestIfRunning<RunSummary>(
    opts.cwd,
    'GET',
    buildPath(API_ROUTES.runSummary, { id: opts.id }),
  );
}

export function apiGetRunState(opts: { cwd: string; id: string }) {
  return daemonRequest<RunState>(
    opts.cwd,
    'GET',
    buildPath(API_ROUTES.runState, { id: opts.id }),
  );
}

export function apiGetPlans(opts: { cwd: string; runId: string }) {
  return daemonRequest<PlansResponse>(
    opts.cwd,
    'GET',
    buildPath(API_ROUTES.plans, { runId: opts.runId }),
  );
}

export function apiGetDiff(opts: { cwd: string; sessionId: string; planId: string; file?: string }) {
  const base = buildPath(API_ROUTES.diff, { sessionId: opts.sessionId, planId: opts.planId });
  const path = opts.file !== undefined ? `${base}?file=${encodeURIComponent(opts.file)}` : base;
  return daemonRequest<DiffResponse>(opts.cwd, 'GET', path);
}

export function apiGetSessionMetadata(opts: { cwd: string }) {
  return daemonRequest<Record<string, SessionMetadata>>(opts.cwd, 'GET', API_ROUTES.sessionMetadata);
}

/**
 * Fetch the latest run by querying GET /api/runs and returning the first entry.
 * Runs are sorted by started_at DESC so index 0 is the most recent.
 * Returns null when no runs exist.
 */
export async function apiGetLatestRunFromRuns(opts: { cwd: string }): Promise<RunInfo | null> {
  const { data } = await daemonRequest<RunInfo[]>(opts.cwd, 'GET', API_ROUTES.runs);
  return data[0] ?? null;
}

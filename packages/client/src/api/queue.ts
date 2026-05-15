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

/**
 * Fetch all currently running sessions.
 * Filters /api/runs to status === 'running' with a valid sessionId.
 * Dedupes by sessionId keeping the first occurrence (newest, since runs are
 * sorted started_at DESC — one session may have multiple rows after recovery/retry).
 */
export async function apiGetRunningRuns(opts: { cwd: string }): Promise<{ data: RunInfo[]; port: number }> {
  const { data, port } = await daemonRequest<RunInfo[]>(opts.cwd, 'GET', API_ROUTES.runs);
  const filtered = data
    .filter((r) => r.status === 'running' && r.sessionId !== undefined)
    .filter((r, i, arr) => arr.findIndex((x) => x.sessionId === r.sessionId) === i);
  return { data: filtered, port };
}

/**
 * Fetch all currently running session summaries.
 * Calls apiGetRunningRuns, then fetches RunSummary for each in parallel via
 * Promise.allSettled. Drops rejected entries silently (transient errors should
 * not blank the full status). Preserves input run order.
 */
export async function apiGetRunningSessionSummaries(opts: { cwd: string }): Promise<Array<{ run: RunInfo; summary: RunSummary }>> {
  const { data: runs } = await apiGetRunningRuns(opts);
  const results = await Promise.allSettled(
    runs.map(async (run) => {
      const { data: summary } = await apiGetRunSummary({ cwd: opts.cwd, id: run.sessionId! });
      return { run, summary };
    }),
  );
  return results
    .filter((r): r is PromiseFulfilledResult<{ run: RunInfo; summary: RunSummary }> => r.status === 'fulfilled')
    .map((r) => r.value);
}

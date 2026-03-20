import type { RunInfo, QueueItem } from './types';

export async function fetchRuns(): Promise<RunInfo[]> {
  const res = await fetch('/api/runs');
  if (!res.ok) throw new Error(`Failed to fetch runs: ${res.status}`);
  return res.json();
}

export async function fetchLatestRunId(): Promise<string | null> {
  const res = await fetch('/api/latest-run');
  if (!res.ok) throw new Error(`Failed to fetch latest run: ${res.status}`);
  const data = await res.json();
  return data.runId ?? null;
}

export async function fetchLatestSessionId(): Promise<string | null> {
  const res = await fetch('/api/latest-run');
  if (!res.ok) throw new Error(`Failed to fetch latest session: ${res.status}`);
  const data = await res.json();
  return data.sessionId ?? data.runId ?? null;
}

export async function fetchOrchestration(runId: string): Promise<unknown> {
  const res = await fetch(`/api/orchestration/${runId}`);
  if (!res.ok) throw new Error(`Failed to fetch orchestration: ${res.status}`);
  return res.json();
}

export async function fetchPlans(runId: string): Promise<unknown[]> {
  const res = await fetch(`/api/plans/${runId}`);
  if (!res.ok) throw new Error(`Failed to fetch plans: ${res.status}`);
  return res.json();
}

export async function fetchQueue(): Promise<QueueItem[]> {
  const res = await fetch('/api/queue');
  if (!res.ok) throw new Error(`Failed to fetch queue: ${res.status}`);
  return res.json();
}

export async function fetchFileDiff(
  sessionId: string,
  planId: string,
  filePath: string,
): Promise<{ diff: string | null; commitSha: string; tooLarge?: boolean; binary?: boolean }> {
  const res = await fetch(`/api/diff/${sessionId}/${planId}?file=${encodeURIComponent(filePath)}`);
  if (!res.ok) throw new Error(`Failed to fetch diff: ${res.status}`);
  return res.json();
}

export async function fetchPlanDiffs(
  sessionId: string,
  planId: string,
): Promise<{ files: Array<{ path: string; diff: string | null; tooLarge?: boolean; binary?: boolean }>; commitSha: string }> {
  const res = await fetch(`/api/diff/${sessionId}/${planId}`);
  if (!res.ok) throw new Error(`Failed to fetch plan diffs: ${res.status}`);
  return res.json();
}

import type { RunInfo } from './types';

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

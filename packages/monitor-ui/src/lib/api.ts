import { API_ROUTES, buildPath, type ReadSidecarResponse } from '@eforge-build/client/browser';

export async function fetchLatestSessionId(): Promise<string | null> {
  const res = await fetch(API_ROUTES.latestRun);
  if (!res.ok) throw new Error(`Failed to fetch latest session: ${res.status}`);
  const data = await res.json();
  return data.sessionId ?? data.runId ?? null;
}

export async function fetchOrchestration(runId: string): Promise<unknown> {
  const res = await fetch(buildPath(API_ROUTES.orchestration, { runId }));
  if (!res.ok) throw new Error(`Failed to fetch orchestration: ${res.status}`);
  return res.json();
}

export async function fetchPlans(runId: string): Promise<unknown[]> {
  const res = await fetch(buildPath(API_ROUTES.plans, { runId }));
  if (!res.ok) throw new Error(`Failed to fetch plans: ${res.status}`);
  return res.json();
}

export async function fetchFileDiff(
  sessionId: string,
  planId: string,
  filePath: string,
): Promise<{ diff: string | null; commitSha: string; tooLarge?: boolean; binary?: boolean }> {
  const res = await fetch(`${buildPath(API_ROUTES.diff, { sessionId, planId })}?file=${encodeURIComponent(filePath)}`);
  if (!res.ok) throw new Error(`Failed to fetch diff: ${res.status}`);
  return res.json();
}

export interface AutoBuildState {
  enabled: boolean;
  watcher: { running: boolean; pid: number | null; sessionId: string | null };
}

export async function fetchAutoBuild(): Promise<AutoBuildState | null> {
  try {
    const res = await fetch(API_ROUTES.autoBuildGet);
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

export async function setAutoBuild(enabled: boolean): Promise<AutoBuildState | null> {
  try {
    const res = await fetch(API_ROUTES.autoBuildSet, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

export async function fetchProjectContext(): Promise<{ cwd: string | null; gitRemote: string | null }> {
  const res = await fetch(API_ROUTES.projectContext);
  if (!res.ok) throw new Error(`Failed to fetch project context: ${res.status}`);
  return res.json();
}

export async function cancelSession(sessionId: string): Promise<{ status: string; sessionId: string } | null> {
  try {
    const res = await fetch(buildPath(API_ROUTES.cancel, { sessionId }), { method: 'POST' });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

export async function triggerRecover(
  setName: string,
  prdId: string,
): Promise<{ sessionId: string; pid: number } | null> {
  try {
    const res = await fetch(API_ROUTES.recover, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ setName, prdId }),
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

export async function applyRecovery(
  prdId: string,
): Promise<{ sessionId: string; pid: number } | null> {
  try {
    const res = await fetch(API_ROUTES.applyRecovery, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prdId }),
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

/**
 * Fetch the recovery sidecar JSON + markdown for a failed PRD.
 *
 * Returns `null` when no sidecar exists (404 — recovery not yet run or
 * pending) or when any other error occurs. Callers should treat `null` as
 * "recovery pending" and not block rendering.
 *
 * Uses `API_ROUTES.readRecoverySidecar` via query params — no literal
 * `/api/...` strings.
 */
export async function fetchRecoverySidecar(
  prdId: string,
): Promise<ReadSidecarResponse | null> {
  try {
    const params = new URLSearchParams({ prdId });
    const res = await fetch(`${API_ROUTES.readRecoverySidecar}?${params.toString()}`);
    if (res.status === 404) return null;
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

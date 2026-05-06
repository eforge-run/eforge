/**
 * Mutation helpers for the eforge daemon HTTP API.
 *
 * This file holds only mutation (POST) helpers. Read fetches are handled
 * through `useSWR(...)` with the shared fetcher from `lib/swr-fetcher.ts`.
 */
import { API_ROUTES, buildPath } from '@eforge-build/client/browser';
import type { ApplyRecoveryResponse } from '@eforge-build/client/browser';

export interface AutoBuildState {
  enabled: boolean;
  watcher: { running: boolean; pid: number | null; sessionId: string | null };
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

/**
 * Apply the recovery verdict for a failed PRD.
 *
 * Returns the parsed success body on 2xx, or `{ error: string }` on non-2xx.
 * Callers must distinguish the two shapes: check for `'error' in result` before
 * treating the response as a successful apply.
 */
export async function applyRecovery(
  prdId: string,
): Promise<ApplyRecoveryResponse | { error: string }> {
  try {
    const res = await fetch(API_ROUTES.applyRecovery, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prdId }),
    });
    if (!res.ok) {
      try {
        const body = await res.json() as { error?: string };
        return { error: body.error ?? `HTTP ${res.status}` };
      } catch {
        return { error: `HTTP ${res.status}` };
      }
    }
    return res.json() as Promise<ApplyRecoveryResponse>;
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Network error' };
  }
}

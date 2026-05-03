import { API_ROUTES } from '@eforge-build/client/browser';

/**
 * Shared SWR fetcher for all monitor-UI useSWR calls.
 *
 * Accepts either a plain URL string (built from API_ROUTES / buildPath) or a
 * tuple key `[route, ...params]`. The only supported tuple shape is
 * `['sidecar', prdId]`, which fetches the recovery sidecar for the given PRD.
 *
 * Return semantics:
 *   - 404            → returns null  (caller treats as "no sidecar / not found")
 *   - other non-2xx  → throws Error containing the HTTP status code
 *   - 2xx            → returns await res.json()
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function fetcher(key: string | [string, ...unknown[]]): Promise<any> {
  let url: string;

  if (Array.isArray(key)) {
    const [route, ...params] = key as [string, ...unknown[]];
    if (route === 'sidecar' && params.length === 1) {
      const prdId = params[0] as string;
      url = `${API_ROUTES.readRecoverySidecar}?${new URLSearchParams({ prdId }).toString()}`;
    } else {
      throw new Error(`Unknown tuple key shape: ${JSON.stringify(key)}`);
    }
  } else {
    url = key;
  }

  const res = await fetch(url);

  if (res.status === 404) {
    return null;
  }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  return res.json();
}

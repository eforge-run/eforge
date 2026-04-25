/**
 * Typed helper for the recovery sidecar read daemon API endpoint.
 */

import { daemonRequest } from '../daemon-client.js';
import { API_ROUTES } from '../routes.js';
import type { ReadSidecarResponse } from '../routes.js';

export function apiReadRecoverySidecar(opts: { cwd: string; setName: string; prdId: string }) {
  const params = new URLSearchParams({ setName: opts.setName, prdId: opts.prdId });
  return daemonRequest<ReadSidecarResponse>(
    opts.cwd,
    'GET',
    `${API_ROUTES.readRecoverySidecar}?${params.toString()}`,
  );
}

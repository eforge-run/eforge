/**
 * Typed helpers for model listing daemon API endpoints.
 */

import { daemonRequest } from '../daemon-client.js';
import { API_ROUTES } from '../routes.js';
import type { ModelProvidersResponse, ModelListResponse } from '../types.js';

export function apiListModelProviders(opts: { cwd: string; backend?: string }) {
  const path = opts.backend !== undefined
    ? `${API_ROUTES.modelProviders}?backend=${encodeURIComponent(opts.backend)}`
    : API_ROUTES.modelProviders;
  return daemonRequest<ModelProvidersResponse>(opts.cwd, 'GET', path);
}

export function apiListModels(opts: { cwd: string; backend?: string; provider?: string }) {
  const params = new URLSearchParams();
  if (opts.backend !== undefined) params.set('backend', opts.backend);
  if (opts.provider !== undefined) params.set('provider', opts.provider);
  const query = params.toString();
  const path = query ? `${API_ROUTES.modelList}?${query}` : API_ROUTES.modelList;
  return daemonRequest<ModelListResponse>(opts.cwd, 'GET', path);
}

/**
 * Typed helpers for model listing daemon API endpoints.
 */

import { daemonRequest } from '../daemon-client.js';
import { API_ROUTES } from '../routes.js';
import type { ModelProvidersResponse, ModelListResponse } from '../types.js';

export function apiListModelProviders(opts: { cwd: string; harness?: string }) {
  const path = opts.harness !== undefined
    ? `${API_ROUTES.modelProviders}?harness=${encodeURIComponent(opts.harness)}`
    : API_ROUTES.modelProviders;
  return daemonRequest<ModelProvidersResponse>(opts.cwd, 'GET', path);
}

export function apiListModels(opts: { cwd: string; harness?: string; provider?: string }) {
  const params = new URLSearchParams();
  if (opts.harness !== undefined) params.set('harness', opts.harness);
  if (opts.provider !== undefined) params.set('provider', opts.provider);
  const query = params.toString();
  const path = query ? `${API_ROUTES.modelList}?${query}` : API_ROUTES.modelList;
  return daemonRequest<ModelListResponse>(opts.cwd, 'GET', path);
}

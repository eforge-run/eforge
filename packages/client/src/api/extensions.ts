/**
 * Typed helpers for native eforge extension daemon API endpoints.
 */

import { daemonRequest } from '../daemon-client.js';
import { API_ROUTES } from '../routes.js';
import type {
  ExtensionListResponse,
  ExtensionNewRequest,
  ExtensionNewResponse,
  ExtensionReloadResponse,
  ExtensionShowResponse,
  ExtensionTestRequest,
  ExtensionTestResponse,
  ExtensionValidateResponse,
} from '../types.js';

function appendQuery(path: string, params: URLSearchParams): string {
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

export function apiListExtensions(opts: { cwd: string }) {
  return daemonRequest<ExtensionListResponse>(opts.cwd, 'GET', API_ROUTES.extensionList);
}

export function apiShowExtension(opts: { cwd: string; name: string }) {
  const params = new URLSearchParams({ name: opts.name });
  return daemonRequest<ExtensionShowResponse>(
    opts.cwd,
    'GET',
    appendQuery(API_ROUTES.extensionShow, params),
  );
}

export function apiValidateExtensions(opts: { cwd: string; name?: string; path?: string }) {
  const params = new URLSearchParams();
  if (opts.name !== undefined) params.set('name', opts.name);
  if (opts.path !== undefined) params.set('path', opts.path);
  return daemonRequest<ExtensionValidateResponse>(
    opts.cwd,
    'GET',
    appendQuery(API_ROUTES.extensionValidate, params),
  );
}

export function apiNewExtension(opts: { cwd: string; body: ExtensionNewRequest }) {
  return daemonRequest<ExtensionNewResponse>(opts.cwd, 'POST', API_ROUTES.extensionNew, opts.body);
}

export function apiReloadExtensions(opts: { cwd: string }) {
  return daemonRequest<ExtensionReloadResponse>(opts.cwd, 'POST', API_ROUTES.extensionReload, {});
}

// --- eforge:region plan-01-engine-daemon-extension-replay ---
export function apiTestExtension(opts: { cwd: string; body: ExtensionTestRequest }) {
  return daemonRequest<ExtensionTestResponse>(opts.cwd, 'POST', API_ROUTES.extensionTest, opts.body);
}
// --- eforge:endregion plan-01-engine-daemon-extension-replay ---

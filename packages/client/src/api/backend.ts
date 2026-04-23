/**
 * Typed helpers for backend profile management daemon API endpoints.
 */

import { daemonRequest } from '../daemon-client.js';
import { API_ROUTES, buildPath } from '../routes.js';
import type {
  BackendListRequest,
  BackendListResponse,
  BackendShowResponse,
  BackendUseRequest,
  BackendUseResponse,
  BackendCreateRequest,
  BackendCreateResponse,
  BackendDeleteRequest,
  BackendDeleteResponse,
} from '../types.js';

export function apiListBackends(opts: { cwd: string; query?: BackendListRequest }) {
  const base = API_ROUTES.backendList;
  const path = opts.query?.scope !== undefined ? `${base}?scope=${encodeURIComponent(opts.query.scope)}` : base;
  return daemonRequest<BackendListResponse>(opts.cwd, 'GET', path);
}

export function apiShowBackend(opts: { cwd: string }) {
  return daemonRequest<BackendShowResponse>(opts.cwd, 'GET', API_ROUTES.backendShow);
}

export function apiUseBackend(opts: { cwd: string; body: BackendUseRequest }) {
  return daemonRequest<BackendUseResponse>(opts.cwd, 'POST', API_ROUTES.backendUse, opts.body);
}

export function apiCreateBackend(opts: { cwd: string; body: BackendCreateRequest }) {
  return daemonRequest<BackendCreateResponse>(opts.cwd, 'POST', API_ROUTES.backendCreate, opts.body);
}

export function apiDeleteBackend(opts: { cwd: string; name: string; body?: BackendDeleteRequest }) {
  return daemonRequest<BackendDeleteResponse>(
    opts.cwd,
    'DELETE',
    buildPath(API_ROUTES.backendDelete, { name: opts.name }),
    opts.body,
  );
}

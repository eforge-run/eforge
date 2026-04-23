/**
 * Typed helpers for daemon config API endpoints.
 */

import { daemonRequest, daemonRequestIfRunning } from '../daemon-client.js';
import { API_ROUTES } from '../routes.js';
import type { ConfigShowResponse, ConfigValidateResponse } from '../types.js';

export function apiShowConfig(opts: { cwd: string }) {
  return daemonRequest<ConfigShowResponse>(opts.cwd, 'GET', API_ROUTES.configShow);
}

export function apiShowConfigIfRunning(opts: { cwd: string }) {
  return daemonRequestIfRunning<ConfigShowResponse>(opts.cwd, 'GET', API_ROUTES.configShow);
}

export function apiValidateConfig(opts: { cwd: string }) {
  return daemonRequest<ConfigValidateResponse>(opts.cwd, 'GET', API_ROUTES.configValidate);
}

export function apiValidateConfigIfRunning(opts: { cwd: string }) {
  return daemonRequestIfRunning<ConfigValidateResponse>(opts.cwd, 'GET', API_ROUTES.configValidate);
}

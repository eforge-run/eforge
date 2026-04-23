/**
 * Typed helpers for daemon lifecycle API endpoints.
 */

import { daemonRequest } from '../daemon-client.js';
import { API_ROUTES } from '../routes.js';
import type { StopDaemonResponse } from '../types.js';
import type { StopDaemonRequest } from '../routes.js';

export function apiStopDaemon(opts: { cwd: string; body?: StopDaemonRequest }) {
  return daemonRequest<StopDaemonResponse>(opts.cwd, 'POST', API_ROUTES.daemonStop, opts.body);
}

/**
 * Typed helper for the scheduler kick endpoint.
 *
 * POST /api/scheduler/kick wakes the daemon's QueueScheduler without relying
 * on filesystem events. Useful when external tooling enqueues a PRD outside
 * the normal daemon routes (e.g. manual git operations).
 */

import { daemonRequest } from '../daemon-client.js';
import { API_ROUTES } from '../routes.js';

/** Response body for POST /api/scheduler/kick */
export interface SchedulerKickResponse {
  ok: true;
}

export function apiSchedulerKick(opts: { cwd: string }): Promise<{ data: SchedulerKickResponse; port: number }> {
  return daemonRequest<SchedulerKickResponse>(opts.cwd, 'POST', API_ROUTES.schedulerKick);
}

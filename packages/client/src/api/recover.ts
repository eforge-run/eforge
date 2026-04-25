/**
 * Typed helper for the recovery trigger daemon API endpoint.
 */

import { daemonRequest } from '../daemon-client.js';
import { API_ROUTES } from '../routes.js';
import type { RecoverRequest, RecoverResponse } from '../routes.js';

export function apiRecover(opts: { cwd: string; body: RecoverRequest }) {
  return daemonRequest<RecoverResponse>(opts.cwd, 'POST', API_ROUTES.recover, opts.body);
}

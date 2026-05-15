/**
 * Error translator — converts thrown values into pipeline event shapes.
 *
 * Centralizes the AgentTerminalError → terminalSubtype extraction so no stage
 * body contains the instanceof check directly.
 */

import type { EforgeEvent } from '../events.js';
import { classifyAgentTerminalSubtype } from '../harness.js';

/**
 * Build a `plan:build:failed` event from a thrown value.
 * - typed terminal or known transient transport errors: includes `terminalSubtype`.
 * - plain Error: uses `err.message`, no `terminalSubtype` unless transient.
 * - non-Error throw: stringifies the value, no `terminalSubtype` unless transient.
 */
export function toBuildFailedEvent(planId: string, err: unknown): EforgeEvent {
  const terminalSubtype = classifyAgentTerminalSubtype(err);
  const message = err instanceof Error ? err.message : String(err);
  return {
    timestamp: new Date().toISOString(),
    type: 'plan:build:failed',
    planId,
    error: message,
    ...(terminalSubtype && { terminalSubtype }),
  } as EforgeEvent;
}

/**
 * Error translator — converts thrown values into pipeline event shapes.
 *
 * Centralizes the AgentTerminalError → terminalSubtype extraction so no stage
 * body contains the instanceof check directly.
 */

import type { EforgeEvent } from '../events.js';
import { AgentTerminalError } from '../backend.js';

/**
 * Build a `plan:build:failed` event from a thrown value.
 * - AgentTerminalError: includes `terminalSubtype` from the error's subtype field.
 * - plain Error: uses `err.message`, no `terminalSubtype`.
 * - non-Error throw: stringifies the value, no `terminalSubtype`.
 */
export function toBuildFailedEvent(planId: string, err: unknown): EforgeEvent {
  const terminalSubtype = err instanceof AgentTerminalError ? err.subtype : undefined;
  const message = err instanceof Error ? err.message : String(err);
  return {
    timestamp: new Date().toISOString(),
    type: 'plan:build:failed',
    planId,
    error: message,
    ...(terminalSubtype && { terminalSubtype }),
  } as EforgeEvent;
}

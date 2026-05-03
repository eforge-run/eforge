/**
 * Miscellaneous handlers for one-off event types that don't fit a logical group.
 *
 * config:warning / planning:warning — log to console (matches current behavior)
 *   and return undefined (no state change). These events flow through the event
 *   stream for traceability; visual surfacing is optional and handled by the UI.
 */
import type { EventHandler } from './handler-types';

export const handleConfigWarning: EventHandler<'config:warning'> = (event, _state) => {
  console.log('[eforge] warning:', event.message);
  return undefined;
};

export const handlePlanningWarning: EventHandler<'planning:warning'> = (event, _state) => {
  console.log('[eforge] warning:', event.message);
  return undefined;
};

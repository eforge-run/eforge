/**
 * Handlers for validation lifecycle events.
 *
 * Owns: validationCommands
 *
 * validation:start         — no-op
 * validation:command:start — append a new running span
 * validation:command:complete — close the most recent open span for the command
 * validation:command:timeout  — close the most recent open span with status 'timeout'
 * validation:complete      — no-op
 *
 * Private helpers:
 *   closeSpan — reverse-walks to find the most recent open span for a command
 */
import type { ValidationCommandSpan } from '../types';
import type { EventHandler } from './handler-types';

// ---------------------------------------------------------------------------
// Private helper
// ---------------------------------------------------------------------------

/**
 * Reverse-walks `spans` and closes the most recent open span where
 * `span.command === command && span.endedAt === null`.
 * Returns the original array reference when no match is found.
 */
function closeSpan(
  spans: ValidationCommandSpan[],
  command: string,
  patch: Pick<ValidationCommandSpan, 'endedAt' | 'status'> & { exitCode?: number | null },
): ValidationCommandSpan[] {
  for (let i = spans.length - 1; i >= 0; i--) {
    const span = spans[i];
    if (span.command === command && span.endedAt === null) {
      return [
        ...spans.slice(0, i),
        {
          ...span,
          endedAt: patch.endedAt,
          status: patch.status,
          exitCode: patch.exitCode !== undefined ? patch.exitCode : span.exitCode,
        },
        ...spans.slice(i + 1),
      ];
    }
  }
  return spans;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export const handleValidationStart: EventHandler<'validation:start'> = (_event, _state) => {
  return undefined;
};

export const handleValidationCommandStart: EventHandler<'validation:command:start'> = (event, state) => {
  const newSpan: ValidationCommandSpan = {
    command: event.command,
    startedAt: event.timestamp,
    endedAt: null,
    status: 'running',
    exitCode: null,
  };
  return { validationCommands: [...state.validationCommands, newSpan] };
};

export const handleValidationCommandComplete: EventHandler<'validation:command:complete'> = (event, state) => {
  const status = event.exitCode === 0 ? 'passed' : 'failed';
  const updated = closeSpan(state.validationCommands, event.command, {
    endedAt: event.timestamp,
    status,
    exitCode: event.exitCode,
  });
  if (updated === state.validationCommands) return undefined;
  return { validationCommands: updated };
};

export const handleValidationCommandTimeout: EventHandler<'validation:command:timeout'> = (event, state) => {
  const updated = closeSpan(state.validationCommands, event.command, {
    endedAt: event.timestamp,
    status: 'timeout',
  });
  if (updated === state.validationCommands) return undefined;
  return { validationCommands: updated };
};

export const handleValidationComplete: EventHandler<'validation:complete'> = (_event, _state) => {
  return undefined;
};

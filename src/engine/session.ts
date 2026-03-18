import type { EforgeEvent, EforgeResult } from './events.js';

export interface SessionOptions {
  /** Pre-set sessionId (for `run` command where plan+build share a session). */
  sessionId?: string;
  /** Emit session:start before the first phase event. */
  emitSessionStart?: boolean;
  /** Emit session:end after the last phase event. */
  emitSessionEnd?: boolean;
}

/**
 * Async generator middleware that stamps `sessionId` on every event
 * and optionally emits session:start/session:end envelope events.
 *
 * For `eforge run` (plan+build composed), the CLI calls this twice with the
 * same sessionId — emitSessionStart on the first call, emitSessionEnd on the
 * second. For standalone plan/build, both flags are true and sessionId is
 * auto-derived from the first phase:start event's runId.
 */
export async function* withSessionId(
  events: AsyncGenerator<EforgeEvent>,
  options: SessionOptions = {},
): AsyncGenerator<EforgeEvent> {
  let sessionId = options.sessionId;
  const emitStart = options.emitSessionStart ?? !options.sessionId;
  const emitEnd = options.emitSessionEnd ?? !options.sessionId;
  let sessionStartEmitted = false;
  let sessionEndEmitted = false;
  let lastResult: EforgeResult | undefined;

  try {
    for await (const event of events) {
      if (!sessionId) {
        if (event.sessionId) {
          sessionId = event.sessionId;
        } else if (event.type === 'phase:start') {
          sessionId = event.runId;
        }
      }

      // Emit session:start before the first event (once we have a sessionId)
      if (emitStart && sessionId && !sessionStartEmitted) {
        yield { type: 'session:start', sessionId, timestamp: ('timestamp' in event && event.timestamp) || new Date().toISOString() } as EforgeEvent;
        sessionStartEmitted = true;
      }

      yield { ...event, sessionId: sessionId ?? event.sessionId } as EforgeEvent;

      if (event.type === 'phase:end') {
        lastResult = event.result;
      }
    }
  } finally {
    // Emit session:end after all events consumed (normal or abnormal termination)
    if (emitEnd && sessionId && !sessionEndEmitted) {
      sessionEndEmitted = true;
      yield {
        type: 'session:end',
        sessionId,
        result: lastResult ?? { status: 'failed', summary: 'Session terminated abnormally' },
        timestamp: new Date().toISOString(),
      } as EforgeEvent;
    }
  }
}

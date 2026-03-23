import type { EforgeEvent, EforgeResult } from './events.js';

export interface SessionOptions {
  /** Pre-set sessionId (for `run` command where plan+build share a session). */
  sessionId?: string;
}

/**
 * Async generator middleware that stamps `sessionId` on every event.
 *
 * Pure passthrough — does not emit session:start/session:end envelope events.
 * When no sessionId is provided, auto-derives from the first event's sessionId
 * or the first phase:start's runId.
 *
 * For queue mode, engine-emitted session:start/session:end flow through unchanged.
 */
export async function* withSessionId(
  events: AsyncGenerator<EforgeEvent>,
  options: SessionOptions = {},
): AsyncGenerator<EforgeEvent> {
  let sessionId = options.sessionId;

  for await (const event of events) {
    if (!sessionId) {
      if (event.sessionId) {
        sessionId = event.sessionId;
      } else if (event.type === 'phase:start') {
        sessionId = event.runId;
      }
    }

    yield { ...event, sessionId: sessionId ?? event.sessionId } as EforgeEvent;
  }
}

/**
 * Async generator wrapper that guarantees session:start/session:end envelope.
 *
 * Emits session:start before the first event, stamps sessionId on all events,
 * and emits session:end in the finally block (guaranteeing it fires even on
 * early generator returns or upstream errors).
 *
 * Session result is derived from the last phase:end event seen, or from
 * enqueue:complete for enqueue-only sessions. If neither was emitted,
 * falls back to { status: 'failed', summary: 'Session terminated abnormally' }.
 */
export async function* runSession(
  events: AsyncGenerator<EforgeEvent>,
  sessionId: string,
): AsyncGenerator<EforgeEvent> {
  let sessionStartEmitted = false;
  let lastResult: EforgeResult | undefined;

  try {
    for await (const event of events) {
      // Emit session:start before the first event
      if (!sessionStartEmitted) {
        yield { type: 'session:start', sessionId, timestamp: ('timestamp' in event && event.timestamp) || new Date().toISOString() } as EforgeEvent;
        sessionStartEmitted = true;
      }

      yield { ...event, sessionId } as EforgeEvent;

      if (event.type === 'phase:end') {
        lastResult = event.result;
      } else if (event.type === 'enqueue:complete') {
        lastResult = { status: 'completed', summary: `Enqueued: ${event.title}` };
      }
    }
  } finally {
    // Guarantee session:end — even if the generator returned early or threw
    if (!sessionStartEmitted) {
      // Edge case: no events at all — still emit start+end
      yield { type: 'session:start', sessionId, timestamp: new Date().toISOString() } as EforgeEvent;
    }
    yield {
      type: 'session:end',
      sessionId,
      result: lastResult ?? { status: 'failed', summary: 'Session terminated abnormally' },
      timestamp: new Date().toISOString(),
    } as EforgeEvent;
  }
}

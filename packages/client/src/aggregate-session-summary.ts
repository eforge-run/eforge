/**
 * Synchronous helper for computing a `SessionSummary` from a flat event array.
 *
 * Engine event-type literals (`'phase:start'`, `'plan:build:files_changed'`,
 * `:error`/`:failed` suffix detection) live here to restore the "no engine
 * deps" layering that `session-stream.ts` claims to honor.
 *
 * `SessionSummary` is imported from `session-stream.ts` to avoid duplication —
 * plan-02 migrated consumers to call this function directly; the inline
 * aggregation in the old session subscriber has been removed.
 */

import type { DaemonStreamEvent, SessionSummary } from './session-stream.js';

export type { SessionSummary };

/**
 * Compute a `SessionSummary` from a flat list of `EforgeEvent`-shaped objects.
 *
 * Scans the event array once, accumulating:
 *  - `eventCount`: total events (including `session:end`)
 *  - `phaseCount`: count of `phase:start` events
 *  - `filesChanged`: sum of `files.length` across `plan:build:files_changed` events
 *  - `errorCount`: count of events whose `type` ends in `:error` or `:failed`
 *
 * Terminal `status` and `summary` are extracted from the last `session:end`
 * event's `result` field. If no `session:end` is present, defaults to
 * `status: 'failed'` and `summary: ''`.
 *
 * @param sessionId  Session identifier included verbatim in the summary.
 * @param events     Flat array of events to aggregate (order matters for
 *                   terminal-event detection).
 * @param monitorUrl `http://127.0.0.1:{port}` pointing at the monitor/daemon.
 */
export function aggregateSessionSummary(
  sessionId: string,
  events: DaemonStreamEvent[],
  monitorUrl: string,
): SessionSummary {
  let eventCount = 0;
  let phaseCount = 0;
  let filesChanged = 0;
  let errorCount = 0;
  let status: 'completed' | 'failed' = 'failed';
  let summary = '';

  for (const event of events) {
    eventCount += 1;

    if (event.type === 'phase:start') {
      phaseCount += 1;
    }

    if (event.type === 'plan:build:files_changed') {
      const files = (event as { files?: unknown }).files;
      if (Array.isArray(files)) {
        filesChanged += files.length;
      }
    }

    if (event.type.endsWith(':error') || event.type.endsWith(':failed')) {
      errorCount += 1;
    }

    if (event.type === 'session:end') {
      const result = (event as { result?: { status?: string; summary?: string } }).result;
      status =
        result?.status === 'completed' || result?.status === 'failed'
          ? result.status
          : 'failed';
      summary = result?.summary ?? '';
    }
  }

  return {
    sessionId,
    status,
    summary,
    monitorUrl,
    eventCount,
    phaseCount,
    filesChanged,
    errorCount,
  };
}

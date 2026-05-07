import { randomUUID } from 'node:crypto';
import type { EforgeEvent } from '@eforge-build/engine/events';
import type { RunInfo } from '@eforge-build/client';
import type { MonitorDB } from './db.js';

/**
 * Build and immediately persist a `daemon:run:upsert` event for the given run.
 *
 * Re-reads the run via `db.getRunById(runId)` after each DB mutation so the
 * wire payload is byte-for-byte equivalent to what `db.getRuns()` would return.
 * Persists the event into the `events` table so it is visible to SSE subscribers
 * via the standard daemon-events poll loop and replayed on reconnect.
 *
 * Returns the constructed event (to be yielded by withRecording), or undefined
 * if the run cannot be found (defensive guard against concurrent deletion).
 *
 * @param db          - The monitor database.
 * @param runId       - The ID of the run to re-read and upsert.
 * @param eventRunId  - The `run_id` FK to use when inserting the event row.
 *                      Almost always the same as `runId`.
 */
function buildAndPersistRunUpsert(
  db: MonitorDB,
  runId: string,
  eventRunId: string,
): EforgeEvent | undefined {
  const runInfo: RunInfo | undefined = db.getRunById(runId);
  if (!runInfo) return undefined;

  const upsertEvent: EforgeEvent = {
    type: 'daemon:run:upsert',
    timestamp: new Date().toISOString(),
    run: runInfo,
  };

  db.insertEvent({
    runId: eventRunId,
    type: 'daemon:run:upsert',
    data: JSON.stringify(upsertEvent),
    timestamp: upsertEvent.timestamp,
  });

  return upsertEvent;
}

/**
 * Middleware generator that records every EforgeEvent to SQLite,
 * then re-yields it unchanged. DB-only writes — no SSE push.
 * The detached server polls the DB for new events.
 *
 * After each DB mutation that creates or updates a run row
 * (insertRun, updateRunStatus, updateRunPlanSet), this generator also
 * emits a synthetic `daemon:run:upsert` event. The payload is re-read from
 * the DB via `getRunById` so it is always equivalent to what `db.getRuns()`
 * would return — making live-event projection provably equivalent to the
 * `stream:hello` snapshot.
 *
 * Concurrency invariant: `enqueueRunId` is a generator-local variable.
 * Each `withRecording()` invocation has its own independent `enqueueRunId`
 * so concurrent enqueue/build sequences in separate daemon workers cannot
 * cross-contaminate each other's run correlation. This property holds because
 * the daemon spawns one subprocess per PRD, each with its own `withRecording()`
 * call and therefore its own independent generator-local state.
 */
export async function* withRecording(
  events: AsyncGenerator<EforgeEvent>,
  db: MonitorDB,
  cwd: string,
  pid?: number,
): AsyncGenerator<EforgeEvent> {
  /**
   * Generator-local correlation id for the current enqueue session.
   * Set on `enqueue:start`, cleared on `session:end`. Phase-driven sessions
   * set this to undefined (phase:start takes over) so the two lifecycles
   * are mutually exclusive within a single withRecording invocation.
   */
  let enqueueRunId: string | undefined;
  const bufferedSessionStarts = new Map<string, EforgeEvent>();

  for await (const event of events) {
    // Guard: don't apply mutation hooks to synthetic daemon:run:upsert events.
    // In normal operation the engine never emits this type; this guard prevents
    // infinite loops if a nested withRecording wraps another withRecording.
    if (event.type === 'daemon:run:upsert') {
      yield event;
      continue;
    }

    // Collect daemon:run:upsert events to yield after the primary event.
    const pendingUpserts: EforgeEvent[] = [];

    if (event.type === 'phase:start') {
      enqueueRunId = undefined; // phase:start takes over from enqueue tracking
      db.insertRun({
        id: event.runId,
        sessionId: event.sessionId,
        planSet: event.planSet,
        command: event.command,
        status: 'running',
        startedAt: event.timestamp,
        cwd,
        pid,
      });
      // Flush buffered session:start if present
      const eventSessionId = 'sessionId' in event ? (event as { sessionId: string }).sessionId : undefined;
      const bufferedStart = eventSessionId ? bufferedSessionStarts.get(eventSessionId) : undefined;
      if (bufferedStart && eventSessionId) {
        db.insertEvent({
          runId: event.runId,
          type: bufferedStart.type,
          planId: extractPlanId(bufferedStart),
          agent: extractAgent(bufferedStart),
          data: JSON.stringify(bufferedStart),
          timestamp: bufferedStart.timestamp,
        });
        bufferedSessionStarts.delete(eventSessionId);
      }
      const upsert = buildAndPersistRunUpsert(db, event.runId, event.runId);
      if (upsert) pendingUpserts.push(upsert);
    }

    if (event.type === 'session:start' && !event.runId && !enqueueRunId) {
      bufferedSessionStarts.set(event.sessionId, event);
    }

    if (event.type === 'enqueue:start') {
      enqueueRunId = randomUUID();
      const firstBuffered = bufferedSessionStarts.values().next().value as EforgeEvent | undefined;
      const sessionId = firstBuffered && 'sessionId' in firstBuffered
        ? (firstBuffered as { sessionId: string }).sessionId
        : undefined;
      db.insertRun({
        id: enqueueRunId,
        sessionId,
        planSet: event.source,
        command: 'enqueue',
        status: 'running',
        startedAt: new Date().toISOString(),
        cwd,
        pid,
      });
      // Flush buffered session:start
      const bufferedEnqueueStart = sessionId ? bufferedSessionStarts.get(sessionId) : undefined;
      if (bufferedEnqueueStart && sessionId) {
        db.insertEvent({
          runId: enqueueRunId,
          type: bufferedEnqueueStart.type,
          planId: extractPlanId(bufferedEnqueueStart),
          agent: extractAgent(bufferedEnqueueStart),
          data: JSON.stringify(bufferedEnqueueStart),
          timestamp: bufferedEnqueueStart.timestamp,
        });
        bufferedSessionStarts.delete(sessionId);
      }
      const upsert = buildAndPersistRunUpsert(db, enqueueRunId, enqueueRunId);
      if (upsert) pendingUpserts.push(upsert);
    }

    const activeRunId = event.runId ?? enqueueRunId;

    if (activeRunId && event.type !== 'session:start') {
      // Extract diffs from build:files_changed events into file_diffs table
      let serializedData: string;
      if (event.type === 'plan:build:files_changed' && event.diffs && event.diffs.length > 0) {
        db.insertFileDiffs(activeRunId, event.planId, event.diffs, event.timestamp);
        // Strip diffs from the event before serializing to events table
        const { diffs: _diffs, ...eventWithoutDiffs } = event;
        serializedData = JSON.stringify(eventWithoutDiffs);
      } else {
        serializedData = JSON.stringify(event);
      }

      db.insertEvent({
        runId: activeRunId,
        type: event.type,
        planId: extractPlanId(event),
        agent: extractAgent(event),
        data: serializedData,
        timestamp: event.timestamp,
      });
    }

    if (event.type === 'enqueue:complete' && enqueueRunId) {
      db.updateRunPlanSet(enqueueRunId, event.planSet);
      db.updateRunStatus(enqueueRunId, 'completed', new Date().toISOString());
      const upsert = buildAndPersistRunUpsert(db, enqueueRunId, enqueueRunId);
      if (upsert) pendingUpserts.push(upsert);
    }

    if (event.type === 'enqueue:failed' && enqueueRunId) {
      db.updateRunStatus(enqueueRunId, 'failed', new Date().toISOString());
      const upsert = buildAndPersistRunUpsert(db, enqueueRunId, enqueueRunId);
      if (upsert) pendingUpserts.push(upsert);
      // NOTE: enqueueRunId is intentionally NOT cleared here. session:end still
      // needs `activeRunId` set to be persisted to the events table. The
      // session:end-failure handler below guards against double-firing by
      // checking the run's current status before re-running updateRunStatus.
    }

    if (event.type === 'phase:end' && event.runId) {
      db.updateRunStatus(event.runId, event.result.status, event.timestamp);
      const upsert = buildAndPersistRunUpsert(db, event.runId, event.runId);
      if (upsert) pendingUpserts.push(upsert);
    }

    if (event.type === 'session:end' && enqueueRunId && !event.runId) {
      if ('result' in event && event.result) {
        const result = event.result as { status: string };
        if (result.status === 'failed') {
          // Skip if enqueue:failed already finalized this run — avoids a
          // redundant updateRunStatus + duplicate daemon:run:upsert emission.
          const current = db.getRunById(enqueueRunId);
          if (current && current.status !== 'failed') {
            db.updateRunStatus(enqueueRunId, 'failed', event.timestamp);
            const upsert = buildAndPersistRunUpsert(db, enqueueRunId, enqueueRunId);
            if (upsert) pendingUpserts.push(upsert);
          }
        }
      }
    }

    if (event.type === 'session:end') {
      enqueueRunId = undefined;
    }

    yield event;

    for (const upsert of pendingUpserts) {
      yield upsert;
    }
  }
}

function extractPlanId(event: EforgeEvent): string | undefined {
  if ('planId' in event && typeof event.planId === 'string') return event.planId;
  if ('moduleId' in event && typeof event.moduleId === 'string') return event.moduleId;
  return undefined;
}

function extractAgent(event: EforgeEvent): string | undefined {
  if ('agent' in event && typeof event.agent === 'string') return event.agent;
  return undefined;
}

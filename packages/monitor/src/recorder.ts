import { randomUUID } from 'node:crypto';
import type { EforgeEvent } from '../engine/events.js';
import type { MonitorDB } from './db.js';

/**
 * Middleware generator that records every EforgeEvent to SQLite,
 * then re-yields it unchanged. DB-only writes — no SSE push.
 * The detached server polls the DB for new events.
 */
export async function* withRecording(
  events: AsyncGenerator<EforgeEvent>,
  db: MonitorDB,
  cwd: string,
  pid?: number,
): AsyncGenerator<EforgeEvent> {
  let enqueueRunId: string | undefined;
  const bufferedSessionStarts = new Map<string, EforgeEvent>();

  for await (const event of events) {
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
    }

    const activeRunId = event.runId ?? enqueueRunId;

    if (activeRunId && event.type !== 'session:start') {
      // Extract diffs from build:files_changed events into file_diffs table
      let serializedData: string;
      if (event.type === 'build:files_changed' && event.diffs && event.diffs.length > 0) {
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
      db.updateRunPlanSet(enqueueRunId, event.title);
      db.updateRunStatus(enqueueRunId, 'completed', new Date().toISOString());
    }

    if (event.type === 'enqueue:failed' && enqueueRunId) {
      db.updateRunStatus(enqueueRunId, 'failed', new Date().toISOString());
    }

    if (event.type === 'phase:end' && event.runId) {
      db.updateRunStatus(event.runId, event.result.status, event.timestamp);
    }

    if (event.type === 'session:end' && enqueueRunId && !event.runId) {
      if ('result' in event && event.result) {
        const result = event.result as { status: string };
        if (result.status === 'failed') {
          db.updateRunStatus(enqueueRunId, 'failed', event.timestamp);
        }
      }
    }

    if (event.type === 'session:end') {
      enqueueRunId = undefined;
    }

    yield event;
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

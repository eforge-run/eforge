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
  let runId: string | undefined;
  let enqueueRunId: string | undefined;
  let bufferedSessionStart: EforgeEvent | undefined;

  for await (const event of events) {
    if (event.type === 'phase:start') {
      runId = event.runId;
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
      if (bufferedSessionStart) {
        db.insertEvent({
          runId: event.runId,
          type: bufferedSessionStart.type,
          planId: extractPlanId(bufferedSessionStart),
          agent: extractAgent(bufferedSessionStart),
          data: JSON.stringify(bufferedSessionStart),
          timestamp: 'timestamp' in bufferedSessionStart ? (bufferedSessionStart as { timestamp: string }).timestamp : new Date().toISOString(),
        });
        bufferedSessionStart = undefined;
      }
    }

    if (event.type === 'session:start' && !runId && !enqueueRunId) {
      bufferedSessionStart = event;
    }

    if (event.type === 'enqueue:start') {
      enqueueRunId = randomUUID();
      const sessionId = bufferedSessionStart && 'sessionId' in bufferedSessionStart
        ? (bufferedSessionStart as { sessionId: string }).sessionId
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
      if (bufferedSessionStart) {
        db.insertEvent({
          runId: enqueueRunId,
          type: bufferedSessionStart.type,
          planId: extractPlanId(bufferedSessionStart),
          agent: extractAgent(bufferedSessionStart),
          data: JSON.stringify(bufferedSessionStart),
          timestamp: 'timestamp' in bufferedSessionStart ? (bufferedSessionStart as { timestamp: string }).timestamp : new Date().toISOString(),
        });
        bufferedSessionStart = undefined;
      }
    }

    const activeRunId = runId ?? enqueueRunId;

    if (activeRunId && event.type !== 'session:start') {
      db.insertEvent({
        runId: activeRunId,
        type: event.type,
        planId: extractPlanId(event),
        agent: extractAgent(event),
        data: JSON.stringify(event),
        timestamp: 'timestamp' in event ? (event as { timestamp: string }).timestamp : new Date().toISOString(),
      });
    }

    if (event.type === 'enqueue:complete' && enqueueRunId) {
      db.updateRunPlanSet(enqueueRunId, event.title);
      db.updateRunStatus(enqueueRunId, 'completed', new Date().toISOString());
    }

    if (event.type === 'enqueue:failed' && enqueueRunId) {
      db.updateRunStatus(enqueueRunId, 'failed', new Date().toISOString());
    }

    if (event.type === 'phase:end' && runId) {
      db.updateRunStatus(runId, event.result.status, event.timestamp);
    }

    if (event.type === 'session:end' && enqueueRunId && !runId) {
      if ('result' in event && event.result) {
        const result = event.result as { status: string };
        if (result.status === 'failed') {
          db.updateRunStatus(enqueueRunId, 'failed', 'timestamp' in event ? (event as { timestamp: string }).timestamp : new Date().toISOString());
        }
      }
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

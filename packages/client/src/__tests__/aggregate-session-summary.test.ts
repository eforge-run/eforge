/**
 * Unit tests for aggregateSessionSummary.
 *
 * Covers:
 * - eventCount increments for every event including session:end.
 * - phaseCount increments only for phase:start events.
 * - filesChanged sums files.length across plan:build:files_changed events.
 * - errorCount increments for events whose type ends in :error or :failed.
 * - Terminal status and summary are extracted from session:end.
 * - Default status is 'failed' when no session:end is present.
 * - Produces correct summary from a typical session event sequence.
 *
 * Follows AGENTS.md conventions:
 * - No mocks. Constructs EforgeEvent-shaped inputs inline.
 */

import { describe, it, expect } from 'vitest';
import { aggregateSessionSummary } from '../aggregate-session-summary.js';
import type { DaemonStreamEvent } from '../session-stream.js';

const TS = '2024-01-01T00:00:00.000Z';

function e(type: string, extra: Record<string, unknown> = {}): DaemonStreamEvent {
  return { type, timestamp: TS, ...extra };
}

describe('aggregateSessionSummary', () => {
  it('returns zero counters and failed status for an empty event array', () => {
    const result = aggregateSessionSummary('sess-1', [], 'http://127.0.0.1:4567');
    expect(result.sessionId).toBe('sess-1');
    expect(result.monitorUrl).toBe('http://127.0.0.1:4567');
    expect(result.eventCount).toBe(0);
    expect(result.phaseCount).toBe(0);
    expect(result.filesChanged).toBe(0);
    expect(result.errorCount).toBe(0);
    expect(result.status).toBe('failed');
    expect(result.summary).toBe('');
  });

  it('counts every event in eventCount', () => {
    const events = [
      e('phase:start', { runId: 'r1', planSet: 'p', command: 'build' }),
      e('agent:start', { agentId: 'a1' }),
      e('session:end', { sessionId: 'sess-2', result: { status: 'completed', summary: 'done' } }),
    ];
    const result = aggregateSessionSummary('sess-2', events, 'http://x');
    expect(result.eventCount).toBe(3);
  });

  it('counts only phase:start events in phaseCount', () => {
    const events = [
      e('phase:start', { runId: 'r1', planSet: 'p', command: 'build' }),
      e('phase:end', { runId: 'r1', result: { status: 'completed', summary: '' } }),
      e('phase:start', { runId: 'r2', planSet: 'p', command: 'build' }),
    ];
    const result = aggregateSessionSummary('s', events, 'http://x');
    expect(result.phaseCount).toBe(2);
  });

  it('sums files.length across plan:build:files_changed events', () => {
    const events = [
      e('plan:build:files_changed', { planId: 'p1', files: ['a.ts', 'b.ts', 'c.ts'] }),
      e('plan:build:files_changed', { planId: 'p2', files: ['d.ts'] }),
    ];
    const result = aggregateSessionSummary('s', events, 'http://x');
    expect(result.filesChanged).toBe(4);
  });

  it('counts events ending in :error in errorCount', () => {
    const events = [
      e('plan:build:failed', { planId: 'p1', error: 'boom' }),
      e('planning:error', { reason: 'oops' }),
      e('agent:start', { agentId: 'a1' }), // not an error
    ];
    const result = aggregateSessionSummary('s', events, 'http://x');
    expect(result.errorCount).toBe(2);
  });

  it('counts events ending in :failed in errorCount', () => {
    const events = [
      e('plan:build:failed', { planId: 'p', error: 'x' }),
      e('phase:end', { runId: 'r', result: { status: 'failed', summary: '' } }), // ends in :end not :failed
    ];
    const result = aggregateSessionSummary('s', events, 'http://x');
    expect(result.errorCount).toBe(1);
  });

  it('extracts completed status and summary from session:end', () => {
    const events = [
      e('phase:start', { runId: 'r', planSet: 'p', command: 'build' }),
      e('session:end', { sessionId: 's', result: { status: 'completed', summary: 'all good' } }),
    ];
    const result = aggregateSessionSummary('s', events, 'http://x');
    expect(result.status).toBe('completed');
    expect(result.summary).toBe('all good');
  });

  it('extracts failed status from session:end', () => {
    const events = [
      e('plan:build:failed', { planId: 'p', error: 'err' }),
      e('session:end', { sessionId: 's', result: { status: 'failed', summary: 'build failed' } }),
    ];
    const result = aggregateSessionSummary('s', events, 'http://x');
    expect(result.status).toBe('failed');
    expect(result.summary).toBe('build failed');
  });

  it('defaults to failed when session:end is absent', () => {
    const events = [
      e('phase:start', { runId: 'r', planSet: 'p', command: 'build' }),
      e('plan:build:failed', { planId: 'p', error: 'err' }),
    ];
    const result = aggregateSessionSummary('s', events, 'http://x');
    expect(result.status).toBe('failed');
    expect(result.summary).toBe('');
  });

  it('produces a correct summary for a typical session event sequence', () => {
    const events: DaemonStreamEvent[] = [
      e('phase:start', { runId: 'r1', planSet: 'ps', command: 'build' }),
      e('plan:build:files_changed', { planId: 'p1', files: ['a.ts', 'b.ts'] }),
      e('plan:build:failed', { planId: 'p1', error: 'crash' }),
      e('session:end', { sessionId: 'sess-ref', result: { status: 'failed', summary: 'failed run' } }),
    ];

    const result = aggregateSessionSummary('sess-ref', events, 'http://127.0.0.1:9999');

    expect(result.sessionId).toBe('sess-ref');
    expect(result.status).toBe('failed');
    expect(result.summary).toBe('failed run');
    expect(result.monitorUrl).toBe('http://127.0.0.1:9999');
    expect(result.eventCount).toBe(4); // all 4 events
    expect(result.phaseCount).toBe(1);
    expect(result.filesChanged).toBe(2);
    expect(result.errorCount).toBe(1); // only plan:build:failed
  });
});

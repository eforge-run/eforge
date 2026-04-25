import { describe, it, expect } from 'vitest';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { wrapWatcherEvents } from '@eforge-build/monitor/server-main';
import { openDatabase } from '@eforge-build/monitor/db';
import type { EforgeEvent } from '@eforge-build/engine/events';
import type { HookConfig } from '@eforge-build/engine/config';

describe('wrapWatcherEvents', () => {
  it('fires session:start hook and persists events to SQLite', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'eforge-daemon-watcher-hooks-'));
    const eforgeDir = resolve(tmpDir, '.eforge');
    mkdirSync(eforgeDir, { recursive: true });
    const dbPath = resolve(eforgeDir, 'monitor.db');
    const db = openDatabase(dbPath);
    const hookOutputFile = join(tmpDir, 'hook-out.txt');

    try {
      const sessionId = 'watcher-session-test-001';
      const runId = 'watcher-run-test-001';
      const now = new Date().toISOString();

      // Hook: fires on session:start and writes EFORGE_EVENT_TYPE and EFORGE_SESSION_ID to a file
      const hooks: HookConfig[] = [
        {
          event: 'session:start',
          command: `echo "EFORGE_EVENT_TYPE=$EFORGE_EVENT_TYPE" > "${hookOutputFile}" && echo "EFORGE_SESSION_ID=$EFORGE_SESSION_ID" >> "${hookOutputFile}"`,
          timeout: 5000,
        },
      ];

      async function* fakeWatcherEvents(): AsyncGenerator<EforgeEvent> {
        // session:start — withRecording buffers this until phase:start arrives;
        // withHooks fires the session:start hook immediately.
        yield {
          type: 'session:start',
          sessionId,
          timestamp: now,
        } as unknown as EforgeEvent;

        // phase:start — withRecording flushes the buffered session:start to the DB
        // and persists this event, creating a run row.
        yield {
          type: 'phase:start',
          runId,
          sessionId,
          planSet: 'test-prd',
          command: 'build',
          timestamp: now,
        } as unknown as EforgeEvent;

        yield {
          type: 'phase:end',
          runId,
          sessionId,
          result: { status: 'completed', summary: 'done' },
          timestamp: now,
        } as unknown as EforgeEvent;

        yield {
          type: 'session:end',
          sessionId,
          result: { status: 'completed', summary: 'done' },
          timestamp: now,
        } as unknown as EforgeEvent;
      }

      // Drain the composed generator — withRecording persists, withHooks fires hooks
      const composed = wrapWatcherEvents(
        fakeWatcherEvents(),
        db,
        tmpDir,
        process.pid,
        hooks,
      );

      const collected: EforgeEvent[] = [];
      for await (const event of composed) {
        collected.push(event);
      }

      // All events should pass through unchanged
      expect(collected).toHaveLength(4);
      expect(collected[0].type).toBe('session:start');
      expect(collected[1].type).toBe('phase:start');

      // Hook output file should contain EFORGE_EVENT_TYPE=session:start and the session id
      const hookOutput = await readFile(hookOutputFile, 'utf-8');
      expect(hookOutput).toContain('EFORGE_EVENT_TYPE=session:start');
      expect(hookOutput).toContain(`EFORGE_SESSION_ID=${sessionId}`);

      // At least one session:start row exists in the SQLite DB proving recording ran
      // (withRecording flushes the buffered session:start when phase:start arrives)
      const sessionStartEvents = db.getEventsByType(runId, 'session:start');
      expect(sessionStartEvents.length).toBeGreaterThan(0);

      // Run row should also exist in the DB
      const run = db.getRun(runId);
      expect(run).toBeDefined();
      expect(run!.status).toBe('completed');
    } finally {
      db.close();
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('passes through all events unchanged when hooks array is empty', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'eforge-daemon-watcher-empty-'));
    const eforgeDir = resolve(tmpDir, '.eforge');
    mkdirSync(eforgeDir, { recursive: true });
    const dbPath = resolve(eforgeDir, 'monitor.db');
    const db = openDatabase(dbPath);

    try {
      const sessionId = 'watcher-session-empty';
      const runId = 'watcher-run-empty';
      const now = new Date().toISOString();

      async function* fakeEvents(): AsyncGenerator<EforgeEvent> {
        yield { type: 'session:start', sessionId, timestamp: now } as unknown as EforgeEvent;
        yield { type: 'phase:start', runId, sessionId, planSet: 'prd', command: 'build', timestamp: now } as unknown as EforgeEvent;
        yield { type: 'phase:end', runId, sessionId, result: { status: 'completed', summary: 'ok' }, timestamp: now } as unknown as EforgeEvent;
        yield { type: 'session:end', sessionId, result: { status: 'completed', summary: 'ok' }, timestamp: now } as unknown as EforgeEvent;
      }

      // Empty hooks — withHooks short-circuits to passthrough
      const composed = wrapWatcherEvents(fakeEvents(), db, tmpDir, process.pid, []);
      const collected: EforgeEvent[] = [];
      for await (const event of composed) {
        collected.push(event);
      }

      expect(collected).toHaveLength(4);
      expect(collected.map((e) => e.type)).toEqual([
        'session:start', 'phase:start', 'phase:end', 'session:end',
      ]);

      // DB recording still runs even with empty hooks
      const run = db.getRun(runId);
      expect(run).toBeDefined();
    } finally {
      db.close();
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('wraps in recording-first order: withHooks(withRecording(events))', async () => {
    // Verify the composition order by confirming that DB insertion happens
    // (recording runs) AND hooks fire for the same events.
    const tmpDir = await mkdtemp(join(tmpdir(), 'eforge-daemon-watcher-order-'));
    const eforgeDir = resolve(tmpDir, '.eforge');
    mkdirSync(eforgeDir, { recursive: true });
    const dbPath = resolve(eforgeDir, 'monitor.db');
    const db = openDatabase(dbPath);
    const hookOrderFile = join(tmpDir, 'hook-order.txt');

    try {
      const sessionId = 'watcher-session-order';
      const runId = 'watcher-run-order';
      const now = new Date().toISOString();

      const hooks: HookConfig[] = [
        {
          event: 'phase:end',
          command: `echo "hook-fired" >> "${hookOrderFile}"`,
          timeout: 5000,
        },
      ];

      async function* fakeEvents(): AsyncGenerator<EforgeEvent> {
        yield { type: 'session:start', sessionId, timestamp: now } as unknown as EforgeEvent;
        yield { type: 'phase:start', runId, sessionId, planSet: 'prd', command: 'build', timestamp: now } as unknown as EforgeEvent;
        yield { type: 'phase:end', runId, sessionId, result: { status: 'completed', summary: 'ok' }, timestamp: now } as unknown as EforgeEvent;
        yield { type: 'session:end', sessionId, result: { status: 'completed', summary: 'ok' }, timestamp: now } as unknown as EforgeEvent;
      }

      const composed = wrapWatcherEvents(fakeEvents(), db, tmpDir, process.pid, hooks);
      const collected: EforgeEvent[] = [];
      for await (const event of composed) {
        collected.push(event);
      }

      expect(collected).toHaveLength(4);

      // Hook fired for phase:end
      const hookContent = await readFile(hookOrderFile, 'utf-8');
      expect(hookContent.trim()).toBe('hook-fired');

      // DB recording ran (run exists and is completed)
      const run = db.getRun(runId);
      expect(run).toBeDefined();
      expect(run!.status).toBe('completed');

      // phase:end event recorded in DB
      const phaseEndEvents = db.getEventsByType(runId, 'phase:end');
      expect(phaseEndEvents.length).toBeGreaterThan(0);
    } finally {
      db.close();
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
